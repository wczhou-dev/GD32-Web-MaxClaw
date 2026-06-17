#!/usr/bin/env node
/**
 * HIL-P1-003 J-Link 烧录封装
 * 调用 JLink.exe 将 HEX 文件烧录到 GD32
 *
 * Usage: node scripts/hil/flash-firmware.js [--config path/to/hil.config.json]
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
    console.error(`[Flash] 配置文件不存在: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ── 主流程 ────────────────────────────────────────────────
function main() {
  const config = loadConfig();
  const { firmware, flash } = config;

  // 校验 HEX 文件
  const hexPath = path.join(firmware.projectDir, firmware.artifact);
  if (!fs.existsSync(hexPath)) {
    console.error(`[Flash] HEX 文件不存在: ${hexPath}`);
    console.error('[Flash] 请先执行编译: node scripts/hil/build-firmware.js');
    process.exit(1);
  }

  // 校验 JLink 工具
  // 优先使用配置的工具路径，否则尝试从 PATH 查找
  let jlinkCmd = flash.tool;
  try {
    // 检查 JLink 是否可用
    execSync(`"${jlinkCmd}" --version`, { stdio: 'pipe', timeout: 5000 });
  } catch {
    // 尝试常见安装路径
    const commonPaths = [
      'C:/Program Files (x86)/SEGGER/JLink/JLink.exe',
      'C:/Program Files/SEGGER/JLink/JLink.exe',
    ];
    const found = commonPaths.find(p => fs.existsSync(p));
    if (found) {
      jlinkCmd = found;
    } else {
      console.error('[Flash] JLink.exe 不可用，请确认已安装并加入 PATH');
      console.error(`[Flash] 配置的工具路径: ${flash.tool}`);
      process.exit(1);
    }
  }

  // 校验 JLink 脚本
  const jlinkScript = path.join(__dirname, '..', 'hil', 'flash_gd32.jlink');
  // 也支持从配置读取相对路径
  const scriptFromConfig = path.resolve(__dirname, '../..', flash.script);
  const finalScript = fs.existsSync(scriptFromConfig) ? scriptFromConfig : jlinkScript;

  if (!fs.existsSync(finalScript)) {
    console.error(`[Flash] JLink 烧录脚本不存在: ${finalScript}`);
    process.exit(1);
  }

  const startTime = Date.now();
  console.log(`[Flash] 开始烧录固件...`);
  console.log(`[Flash] HEX 文件: ${hexPath}`);
  console.log(`[Flash] 芯片型号: ${flash.device}`);
  console.log(`[Flash] 调试接口: ${flash.interface} @ ${flash.speed} kHz`);
  console.log(`[Flash] 烧录脚本: ${finalScript}`);

  // 动态生成 JLink 命令文件（写入临时文件，JLink 不支持从 stdin 读取）
  const os = require('os');
  const tmpCmdFile = path.join(os.tmpdir(), `hil-flash-${Date.now()}.jlink`);
  const jlinkCommands = [
    `si ${flash.interface === 'SWD' ? 1 : 0}`,
    `speed ${flash.speed}`,
    `device ${flash.device}`,
    'connect',
    'r',   // reset
    'h',   // halt
    `loadfile ${hexPath.replace(/\\/g, '/')} ${firmware.appBaseAddress}`,
    'g',   // go
    'q',   // quit
  ];
  fs.writeFileSync(tmpCmdFile, jlinkCommands.join('\n'), 'utf-8');

  try {
    const output = execSync(`"${jlinkCmd}" -device ${flash.device} -if ${flash.interface} -speed ${flash.speed} -nogui 1 -autoconnect 1 -CommandFile "${tmpCmdFile}"`, {
      encoding: 'utf-8',
      timeout: flash.timeoutMs || 60000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Flash] 烧录成功! 耗时 ${elapsed}s`);

    const result = {
      success: true,
      hexPath,
      device: flash.device,
      elapsed: parseFloat(elapsed),
      timestamp: new Date().toISOString()
    };
    console.log(`[Flash] RESULT_JSON:${JSON.stringify(result)}`);

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[Flash] 烧录失败! 耗时 ${elapsed}s`);

    if (err.stdout) {
      console.error('--- JLink 输出 ---');
      console.error(err.stdout);
    }
    if (err.stderr) {
      console.error('--- JLink 错误 ---');
      console.error(err.stderr);
    }

    // 常见错误提示
    const errMsg = (err.stderr || err.stdout || err.message || '').toLowerCase();
    if (errMsg.includes('cannot') && errMsg.includes('connect')) {
      console.error('[Flash] 提示: 无法连接目标芯片，请检查:');
      console.error('  1. J-Link 调试器是否已连接');
      console.error('  2. SWD 接线是否正确 (GND, SWDIO, SWCLK)');
      console.error('  3. 目标板是否已上电');
    }

    const result = {
      success: false,
      error: err.message,
      elapsed: parseFloat(elapsed),
      timestamp: new Date().toISOString()
    };
    console.log(`[Flash] RESULT_JSON:${JSON.stringify(result)}`);
    process.exit(1);
  }
}

main();
