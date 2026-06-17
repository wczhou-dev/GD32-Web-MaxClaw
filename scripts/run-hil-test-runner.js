#!/usr/bin/env node
/**
 * HIL 主控调度脚本
 * 串联编译、烧录、上线检测、ATE 测试、报告生成的完整流程
 *
 * Usage:
 *   node scripts/run-hil-test-runner.js --case T-READ-001
 *   node scripts/run-hil-test-runner.js --case T-READ-001,T-ABNF-001 --config config/hil.config.json
 *   node scripts/run-hil-test-runner.js --case T-READ-001 --port COM4 --rs485-port COM5
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ── 配置加载 ──────────────────────────────────────────────
function loadConfig() {
  const configArg = process.argv.find(a => a.startsWith('--config='));
  const configPath = configArg
    ? configArg.split('=')[1]
    : path.join(__dirname, '../config/hil.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`[HIL] 配置文件不存在: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ── 命令行参数解析 ────────────────────────────────────────
function parseArgs() {
  const args = {
    caseIds: [],
    port: null,
    rs485Port: null,
    skipBuild: false,
    skipFlash: false,
  };

  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--case=')) {
      args.caseIds = arg.split('=')[1].split(',').map(s => s.trim());
    } else if (arg === '--case' && i + 1 < rawArgs.length) {
      args.caseIds = rawArgs[++i].split(',').map(s => s.trim());
    } else if (arg.startsWith('--port=')) {
      args.port = arg.split('=')[1];
    } else if (arg === '--port' && i + 1 < rawArgs.length) {
      args.port = rawArgs[++i];
    } else if (arg.startsWith('--rs485-port=')) {
      args.rs485Port = arg.split('=')[1];
    } else if (arg === '--rs485-port' && i + 1 < rawArgs.length) {
      args.rs485Port = rawArgs[++i];
    } else if (arg === '--skip-build') {
      args.skipBuild = true;
    } else if (arg === '--skip-flash') {
      args.skipFlash = true;
    }
  }

  return args;
}

// ── HTTP 请求封装 ──────────────────────────────────────────
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || { 'Content-Type': 'application/json' },
      timeout: options.timeout || 10000,
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

// ── 资源锁 ────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, '../logs/hil.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    console.error(`[HIL] 资源锁已存在，由进程 ${lockData.pid} 创建于 ${lockData.createdAt}`);
    if (process.argv.includes('--force-unlock')) {
      console.log('[HIL] --force-unlock: 强制删除锁文件');
      fs.unlinkSync(LOCK_FILE);
    } else {
      console.error('[HIL] 使用 --force-unlock 可强制覆盖（请确认无其他 HIL 进程运行）');
      process.exit(1);
    }
  }

  const lockData = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData, null, 2));
}

function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) {
    fs.unlinkSync(LOCK_FILE);
  }
}

// ── 设备上线检测 ──────────────────────────────────────────
function checkDeviceOnline(config, retries = 3) {
  const { controller } = config;
  console.log(`[HIL] 检测设备上线: ${controller.ip}:${controller.modbusTcpPort}`);

  for (let i = 0; i < retries; i++) {
    try {
      // 使用 Modbus TCP 探测（简单 TCP 连接测试）
      const net = require('net');
      const result = execSync(
        `node -e "const net=require('net');const c=net.createConnection(${controller.modbusTcpPort},'${controller.ip}');c.on('connect',()=>{console.log('ONLINE');c.destroy()});c.on('error',()=>{console.log('OFFLINE');process.exit(1)});setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},5000)"`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      if (result.trim().includes('ONLINE')) {
        console.log(`[HIL] 设备在线 ✓`);
        return true;
      }
    } catch {
      // 继续重试
    }

    if (i < retries - 1) {
      console.log(`[HIL] 设备未响应，${5} 秒后重试 (${i + 1}/${retries})...`);
      execSync('sleep 5', { stdio: 'ignore' });
    }
  }

  console.error(`[HIL] 设备不在线，已重试 ${retries} 次`);
  return false;
}

// ── 触发 ATE 测试 ─────────────────────────────────────────
async function triggerTest(config, args) {
  const { ate, controller } = config;
  const baseUrl = ate.baseUrl;
  const sessionId = `hil-${Date.now()}`;

  console.log(`[HIL] 触发 ATE 测试...`);
  console.log(`[HIL] Session: ${sessionId}`);
  console.log(`[HIL] 测试用例: ${args.caseIds.join(', ')}`);

  // 检查 ATE 后端是否在线
  try {
    const health = await httpRequest(`${baseUrl}/api/health`);
    if (health.status !== 200) {
      console.error(`[HIL] ATE 后端不健康 (status: ${health.status})`);
      return null;
    }
  } catch (err) {
    console.error(`[HIL] ATE 后端不可达: ${err.message}`);
    console.error('[HIL] 请先启动后端: node backend/server.js');
    return null;
  }

  // 启动批量测试
  const payload = {
    sessionName: sessionId,
    mode: 'hil',
    caseIds: args.caseIds,
    device: {
      ip: controller.ip,
      modbusTcpPort: controller.modbusTcpPort
    },
    simulator: {
      profile: 'p1-default',
      rs485Port: args.rs485Port || config.serial?.sensorRs485Port
    },
    options: {
      stopOnFail: false,
      collectModbusFrames: true,
      collectFirmwareLog: true
    }
  };

  try {
    const resp = await httpRequest(`${baseUrl}${ate.batchApi}`, {
      method: 'POST',
      body: payload,
      timeout: 30000
    });

    if (resp.status === 200 && resp.data?.success) {
      console.log(`[HIL] 测试已启动, session: ${resp.data.sessionId || sessionId}`);
      return resp.data.sessionId || sessionId;
    } else {
      console.error(`[HIL] 测试启动失败:`, resp.data);
      return null;
    }
  } catch (err) {
    console.error(`[HIL] 请求失败: ${err.message}`);
    return null;
  }
}

// ── 轮询测试结果 ──────────────────────────────────────────
async function pollTestResult(config, sessionId) {
  const { ate } = config;
  const baseUrl = ate.baseUrl;
  const timeoutMs = ate.timeoutMs || 180000;
  const startTime = Date.now();
  const pollInterval = 3000; // 3 秒轮询一次

  console.log(`[HIL] 等待测试结果 (超时 ${timeoutMs / 1000}s)...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const resp = await httpRequest(
        `${baseUrl}${ate.sessionApi}?sessionId=${sessionId}`
      );

      if (resp.status === 200 && resp.data) {
        const { status, progress, currentCaseId } = resp.data;

        if (progress) {
          const pct = Math.round((progress.finished / progress.total) * 100);
          process.stdout.write(`\r[HIL] 进度: ${progress.finished}/${progress.total} (${pct}%) | 当前: ${currentCaseId || '-'} | 通过: ${progress.passed} 失败: ${progress.failed}   `);
        }

        if (status === 'completed' || status === 'finished') {
          console.log('\n[HIL] 测试完成!');
          return resp.data;
        }
      }
    } catch (err) {
      // 轮询出错不终止，继续重试
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  console.error('\n[HIL] 测试超时');
  return null;
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const args = parseArgs();

  // 校验参数
  if (args.caseIds.length === 0) {
    console.error('[HIL] 请指定测试用例: --case T-READ-001');
    console.error('[HIL] 可用命令:');
    console.error('  node scripts/run-hil-test-runner.js --case T-READ-001');
    console.error('  node scripts/run-hil-test-runner.js --case T-READ-001,T-ABNF-001 --port COM4');
    process.exit(1);
  }

  const startTime = Date.now();
  const results = {
    sessionId: null,
    cases: [],
    startTime: new Date().toISOString(),
  };

  console.log('═══════════════════════════════════════════════');
  console.log('  HIL 自动化测试 v1.0');
  console.log('═══════════════════════════════════════════════');

  // 获取资源锁
  acquireLock();

  try {
    // ── Step 1: 编译 ──
    if (!args.skipBuild) {
      console.log('\n── Step 1/4: 编译固件 ──');
      try {
        execSync(`node ${path.join(__dirname, 'hil/build-firmware.js')}`, {
          stdio: 'inherit',
          timeout: 300000
        });
      } catch {
        console.error('[HIL] 编译失败，终止测试');
        process.exit(1);
      }
    } else {
      console.log('\n── Step 1/4: 编译固件 [跳过] ──');
    }

    // ── Step 2: 烧录 ──
    if (!args.skipFlash) {
      console.log('\n── Step 2/4: 烧录固件 ──');
      try {
        execSync(`node ${path.join(__dirname, 'hil/flash-firmware.js')}`, {
          stdio: 'inherit',
          timeout: 120000
        });
      } catch {
        console.error('[HIL] 烧录失败，终止测试');
        process.exit(1);
      }

      // 等待设备重启
      console.log(`[HIL] 等待设备重启 (${config.controller.rebootWaitMs / 1000}s)...`);
      execSync(`sleep ${Math.ceil(config.controller.rebootWaitMs / 1000)}`, { stdio: 'ignore' });
    } else {
      console.log('\n── Step 2/4: 烧录固件 [跳过] ──');
    }

    // ── Step 3: 检测上线 ──
    console.log('\n── Step 3/4: 检测设备上线 ──');
    const online = checkDeviceOnline(config);
    if (!online) {
      console.error('[HIL] 设备未上线，终止测试');
      process.exit(1);
    }

    // ── Step 4: 触发测试 ──
    console.log('\n── Step 4/4: 执行 ATE 测试 ──');
    const sessionId = await triggerTest(config, args);
    if (!sessionId) {
      console.error('[HIL] 测试启动失败，终止');
      process.exit(1);
    }
    results.sessionId = sessionId;

    // 轮询结果
    const testResult = await pollTestResult(config, sessionId);
    if (testResult) {
      results.cases = testResult.cases || [];
      results.progress = testResult.progress;
      results.status = testResult.status;
    }

  } finally {
    // 释放资源锁
    releaseLock();
  }

  // ── 生成报告 ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  results.endTime = new Date().toISOString();
  results.duration = parseFloat(elapsed);

  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // 写入详细报告
  const reportPath = path.join(reportsDir, `${results.sessionId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  // 更新 latest 摘要
  const latestPath = path.join(reportsDir, 'latest-hil-summary.json');
  const passed = results.cases.filter(c => c.status === 'pass').length;
  const failed = results.cases.filter(c => c.status === 'fail').length;
  const summary = {
    sessionId: results.sessionId,
    timestamp: results.endTime,
    status: failed > 0 ? 'failed' : 'passed',
    totalCases: results.cases.length,
    passed,
    failed,
    duration: results.duration,
    cases: results.cases
  };
  fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2));

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  测试完成! 总耗时 ${elapsed}s`);
  console.log(`  总计: ${results.cases.length} | 通过: ${passed} | 失败: ${failed}`);
  console.log(`  报告: ${reportPath}`);
  console.log('═══════════════════════════════════════════════');

  // 如果有失败，触发失败上下文归集
  if (failed > 0) {
    console.log('\n[HIL] 检测到失败用例，归集失败上下文...');
    const failCase = results.cases.find(c => c.status === 'fail');
    if (failCase) {
      try {
        execSync(
          `node ${path.join(__dirname, 'hil/collect-error-context.js')} ` +
          `--session=${results.sessionId} ` +
          `--case=${failCase.caseId} ` +
          `--failedAt=${results.endTime} ` +
          `--summary="${failCase.error || 'Test failed'}"`,
          { stdio: 'inherit' }
        );
      } catch {
        console.error('[HIL] 失败上下文归集出错');
      }
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`[HIL] 未处理异常: ${err.message}`);
  releaseLock();
  process.exit(1);
});
