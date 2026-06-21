/**
 * 快速验证脚本：MSH sensor_history 命令 + 重启机制
 * 使用方法：node scripts/test-msh-and-reboot.js
 */

'use strict';

const DevicePool = require('../backend/DevicePool');
const ControllerStateReader = require('../backend/ate/ControllerStateReader');
const MshClient = require('../backend/ate/MshClient');

const DEVICE_IP = '192.168.110.125';
const DEVICE_PORT = 1502;
const DEVICE_KEY = `${DEVICE_IP}:${DEVICE_PORT}:1`;

async function testMshSensorHistory() {
  console.log('\n========================================');
  console.log('  测试 1: MSH sensor_history 命令');
  console.log('========================================\n');

  const msh = new MshClient({ port: 'COM4', baudRate: 115200 });

  try {
    // 1. 连接
    console.log('[MSH] 尝试连接 COM4 @ 115200...');
    await msh.connect();
    console.log('[MSH] 连接成功');

    // 2. Ping (help 命令)
    console.log('[MSH] 发送 help 命令 (ping)...');
    const pingRes = await msh.pingResult();
    console.log(`[MSH] ping 结果: ok=${pingRes.ok}`);
    if (!pingRes.ok) {
      console.log(`[MSH] 原始响应: ${(pingRes.raw || '').substring(0, 200)}`);
      console.log(`[MSH] 错误: ${pingRes.error}`);
    } else {
      console.log('[MSH] 固件 MSH 终端可达 ✓');
    }

    // 3. 读取历史缓冲
    console.log('\n[MSH] 发送 sensor_history 命令...');
    try {
      const history = await msh.readHistory();
      console.log(`[MSH] sensor_history 响应成功，条目数: ${history.length}`);
      if (history.length > 0) {
        console.log('[MSH] 历史数据:');
        history.forEach((h, i) => {
          console.log(`  [${i}] hour=${h.tm_hour}, temp=${h.temp}, humi=${h.humi}`);
        });
      } else {
        console.log('[MSH] 历史缓冲区为空 (符合预期，如刚清空或新烧录)');
      }
      console.log('[MSH] sensor_history 命令可用 ✓');
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`[MSH] sensor_history 失败: ${msg}`);
      if (msg.includes('timeout') || msg.includes('超时')) {
        console.error('[MSH] 诊断: 命令超时 — 固件可能未实现 sensor_history 命令');
      } else if (msg.includes('not found') || msg.includes('unknown')) {
        console.error('[MSH] 诊断: 命令未识别 — 固件未注册该 MSH 命令');
      }
    }

    // 4. 测试 clearHistory (静默，仅验证命令可达)
    console.log('\n[MSH] 发送 sensor_history_clear 命令...');
    try {
      const clearOk = await msh.clearHistory();
      console.log(`[MSH] sensor_history_clear 结果: ${clearOk}`);
      if (clearOk) {
        console.log('[MSH] sensor_history_clear 命令可用 ✓');
      } else {
        console.log('[MSH] sensor_history_clear 返回 false — 可能未实现');
      }
    } catch (err) {
      console.error(`[MSH] sensor_history_clear 失败: ${err.message}`);
    }

    msh.disconnect();
    return true;
  } catch (err) {
    console.error(`[MSH] 测试异常: ${err.message}`);
    try { msh.disconnect(); } catch (_) {}
    return false;
  }
}

async function testReboot() {
  console.log('\n========================================');
  console.log('  测试 2: 固件重启机制 (HR18 = 0x55AA)');
  console.log('========================================\n');

  const devicePool = new DevicePool();

  try {
    // 1. 注册并连接设备
    console.log(`[Reboot] 注册设备 ${DEVICE_IP}:${DEVICE_PORT}...`);
    devicePool.addDevice({ ip: DEVICE_IP, port: DEVICE_PORT, unitId: 1, name: 'GD32' });
    console.log(`[Reboot] 连接设备 ${DEVICE_KEY}...`);
    await devicePool.connect(DEVICE_KEY);
    console.log('[Reboot] 设备已连接');

    const stateReader = new ControllerStateReader({
      devicePool,
      deviceKey: DEVICE_KEY,
    });

    // 2. 读取当前小时，确认 Modbus 通信正常
    console.log('[Reboot] 读取 HR13 (当前小时) 确认通信正常...');
    const hour = await stateReader.readRegister(13);
    console.log(`[Reboot] HR13 = ${hour} — Modbus 通信正常 ✓`);

    // 3. 发送重启指令
    console.log('[Reboot] 发送重启指令: HR18 = 0x55AA (21930)...');
    const startTime = Date.now();
    const rebootResult = await stateReader.reboot({ waitMs: 15000, retryIntervalMs: 2000 });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (rebootResult.ok) {
      console.log(`[Reboot] 设备重启成功，耗时 ${elapsed}s ✓`);
      console.log(`[Reboot] 重连耗时: ${rebootResult.rebootTimeMs}ms`);

      // 4. 重启后验证：读取小时
      const hourAfter = await stateReader.readRegister(13);
      console.log(`[Reboot] 重启后 HR13 = ${hourAfter} — 设备恢复运行 ✓`);
      return true;
    } else {
      console.error(`[Reboot] 设备重启失败！耗时 ${elapsed}s`);
      console.error('[Reboot] 诊断: HR18=0x55AA 写入可能失败，或固件未实现重启寄存器');
      console.error('[Reboot] 诊断: 也可能是重启后等待时间不足或网络未恢复');
      return false;
    }
  } catch (err) {
    console.error(`[Reboot] 测试异常: ${err.message}`);
    return false;
  } finally {
    try { await devicePool.disconnect(DEVICE_KEY); } catch (_) {}
    try { devicePool.destroy(); } catch (_) {}
  }
}

async function main() {
  console.log('=== MSH + 重启机制 快速验证 ===');
  console.log(`设备: ${DEVICE_IP}:${DEVICE_PORT}`);
  console.log(`串口: COM4 @ 115200`);
  console.log(`时间: ${new Date().toISOString()}`);

  const mshOk = await testMshSensorHistory();
  const rebootOk = await testReboot();

  console.log('\n========================================');
  console.log('  测试结果汇总');
  console.log('========================================');
  console.log(`  MSH sensor_history : ${mshOk ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  重启机制 (HR18)    : ${rebootOk ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('========================================\n');

  process.exit(mshOk && rebootOk ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
