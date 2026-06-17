#!/usr/bin/env node
/**
 * HIL-P1-002 固件编译封装
 * 调用 RT-Thread Env / SCons 编译流程
 *
 * Usage: node scripts/hil/build-firmware.js [--config path/to/hil.config.json]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 配置加载 ──────────────────────────────────────────────
function loadConfig() {
  const configArg = process.argv.find(a => a.startsWith('--config='));
  const configPath = configArg
    ? configArg.split('=')[1]
    : path.join(__dirname, '../../config/hil.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`[Build] 配置文件不存在: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ── 主流程 ────────────────────────────────────────────────
function main() {
  const config = loadConfig();
  const { firmware } = config;

  // 校验项目目录
  if (!fs.existsSync(firmware.projectDir)) {
    console.error(`[Build] 固件工程目录不存在: ${firmware.projectDir}`);
    process.exit(1);
  }

  const startTime = Date.now();
  console.log(`[Build] 开始编译固件...`);
  console.log(`[Build] 工程目录: ${firmware.projectDir}`);
  console.log(`[Build] 编译命令: ${firmware.buildCommand}`);

  // 设置 RT-Thread Env 环境变量
  const env = { ...process.env };
  if (firmware.rttExecPath) {
    env.PATH = `${firmware.rttExecPath};${env.PATH}`;
    env.RTT_EXEC_PATH = firmware.rttExecPath;
  }

  try {
    const output = execSync(firmware.buildCommand, {
      cwd: firmware.projectDir,
      env,
      encoding: 'utf-8',
      timeout: 300000, // 5 分钟超时
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // 检查 HEX 文件是否存在
    const hexPath = path.join(firmware.projectDir, firmware.artifact);
    if (!fs.existsSync(hexPath)) {
      console.error(`[Build] 编译完成但未找到 HEX 文件: ${hexPath}`);
      console.error('[Build] 可能存在链接错误');
      process.exit(1);
    }

    const hexStat = fs.statSync(hexPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Build] 编译成功! 耗时 ${elapsed}s`);
    console.log(`[Build] HEX 文件: ${hexPath}`);
    console.log(`[Build] 文件大小: ${(hexStat.size / 1024).toFixed(1)} KB`);
    console.log(`[Build] 最后修改: ${hexStat.mtime.toISOString()}`);

    // 输出编译结果 JSON 供上层脚本解析
    const result = {
      success: true,
      hexPath,
      hexSize: hexStat.size,
      hexModified: hexStat.mtime.toISOString(),
      elapsed: parseFloat(elapsed),
      timestamp: new Date().toISOString()
    };
    console.log(`[Build] RESULT_JSON:${JSON.stringify(result)}`);

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[Build] 编译失败! 耗时 ${elapsed}s`);

    // 输出编译错误信息
    if (err.stdout) {
      console.error('--- 编译输出 (stdout) ---');
      console.error(err.stdout);
    }
    if (err.stderr) {
      console.error('--- 编译错误 (stderr) ---');
      console.error(err.stderr);
    }

    const result = {
      success: false,
      error: err.message,
      elapsed: parseFloat(elapsed),
      timestamp: new Date().toISOString()
    };
    console.log(`[Build] RESULT_JSON:${JSON.stringify(result)}`);
    process.exit(1);
  }
}

main();
