#!/usr/bin/env node
/**
 * HIL 设备上线检测
 * 通过 TCP 连接探测环控器是否在线
 *
 * Usage: node scripts/hil/check-device-online.js [--config path/to/hil.config.json] [--retries 3]
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

// ── 配置加载 ──────────────────────────────────────────────
function loadConfig() {
  const configArg = process.argv.find(a => a.startsWith('--config='));
  const configPath = configArg
    ? configArg.split('=')[1]
    : path.join(__dirname, '../../config/hil.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`[Check] 配置文件不存在: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ── TCP 探测 ──────────────────────────────────────────────
function probeDevice(ip, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.createConnection({ host: ip, port });

    const done = (online) => {
      socket.destroy();
      resolve({ online, latencyMs: Date.now() - start });
    };

    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
    socket.setTimeout(timeoutMs);
  });
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const config = loadConfig();
  const { controller } = config;

  const retriesArg = process.argv.find(a => a.startsWith('--retries='));
  const retries = retriesArg ? parseInt(retriesArg.split('=')[1]) : 3;

  const ip = controller.ip;
  const port = controller.modbusTcpPort;

  console.log(`[Check] 探测设备: ${ip}:${port}`);

  for (let i = 0; i < retries; i++) {
    const { online, latencyMs } = await probeDevice(ip, port);

    if (online) {
      console.log(`[Check] 设备在线 ✓ (延迟: ${latencyMs}ms)`);
      const result = { success: true, ip, port, latencyMs, timestamp: new Date().toISOString() };
      console.log(`[Check] RESULT_JSON:${JSON.stringify(result)}`);
      process.exit(0);
    }

    console.log(`[Check] 第 ${i + 1}/${retries} 次探测失败`);
    if (i < retries - 1) {
      console.log(`[Check] 5 秒后重试...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.error(`[Check] 设备不在线，已重试 ${retries} 次`);
  const result = { success: false, ip, port, timestamp: new Date().toISOString() };
  console.log(`[Check] RESULT_JSON:${JSON.stringify(result)}`);
  process.exit(1);
}

main();
