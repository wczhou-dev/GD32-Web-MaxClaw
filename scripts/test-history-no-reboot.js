/**
 * 验证历史数据保存（无重启）
 */
'use strict';

const MshClient = require('../backend/ate/MshClient');
const DevicePool = require('../backend/DevicePool');

const IP = '192.168.110.125';
const PORT = 1502;
const KEY = `${IP}:${PORT}:1`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readActual(dp) {
  const r = await dp.readHoldingRegisters(KEY, 0x103B, 2);
  const t = (r.data[0] > 32767 ? r.data[0] - 65536 : r.data[0]) / 10;
  const h = r.data[1] / 10;
  return { temp: t, humi: h };
}

async function syncTime(dp, year, month, day, hour, min, sec) {
  try {
    await dp.writeRegisters(KEY, 10, [year, month, day, hour, min, sec]);
  } catch (e) {
    console.log(`    writeRegisters 失败: ${e.message}，重连后重试...`);
    await dp.disconnect(KEY).catch(() => {});
    await sleep(2000);
    await dp.connect(KEY);
    await dp.writeRegisters(KEY, 10, [year, month, day, hour, min, sec]);
  }
  await sleep(500);
  try {
    await dp.writeRegister(KEY, 16, 1);
  } catch (e) {
    console.log(`    writeRegister(HR16) 失败: ${e.message}，重连后重试...`);
    await dp.disconnect(KEY).catch(() => {});
    await sleep(2000);
    await dp.connect(KEY);
    await dp.writeRegister(KEY, 16, 1);
  }
  await sleep(500);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const r = await dp.readHoldingRegisters(KEY, 17, 1);
      if (r.data[0] === 0) return true;
    } catch (e) {
      // 重连后继续
      await dp.disconnect(KEY).catch(() => {});
      await sleep(1000);
      await dp.connect(KEY);
    }
  }
  return false;
}

async function main() {
  console.log('=== 历史数据保存验证（无重启） ===');
  console.log('时间:', new Date().toISOString());

  const msh = new MshClient({ port: 'COM4', baudRate: 115200 });
  const dp = new DevicePool();
  dp.addDevice({ ip: IP, port: PORT, unitId: 1, name: 'GD32' });
  await dp.connect(KEY);
  await sleep(2000); // 等设备稳定

  try {
    // 1. MSH
    await msh.connect();
    const ping = await msh.pingResult();
    console.log(`[1] MSH ping: ${ping.ok}`);
    if (!ping.ok) throw new Error('MSH 不可达');

    // 2. 基线
    let base;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        base = await readActual(dp);
        break;
      } catch (e) {
        console.log(`    读取失败 (${attempt}/3): ${e.message}`);
        await sleep(2000);
      }
    }
    if (!base) throw new Error('无法读取 ActualTemp');
    console.log(`[2] 基线: ActualTemp=${base.temp}, ActualHumi=${base.humi}`);

    // 3. 清空历史
    await msh.clearHistory();
    const h0 = await msh.readHistory();
    console.log(`[3] 清空后条目数: ${h0.length}`);

    // 4. 对时到当前小时:59:50
    const now = new Date();
    const curHour = now.getHours();
    const targetHour = (curHour + 1) % 24;
    console.log(`[4] 对时到 ${curHour}:59:50 → 等跨 ${targetHour}:00`);
    const ok = await syncTime(dp, now.getFullYear(), now.getMonth() + 1, now.getDate(), curHour, 59, 50);
    console.log(`    对时: ${ok ? '成功' : '失败'}`);

    // 5. 等跨小时
    console.log('[5] 等待 15 秒...');
    await sleep(15000);

    // 6. 读历史
    const history = await msh.readHistory();
    console.log(`[6] 历史条目数: ${history.length}`);
    history.forEach((h, i) => console.log(`    [${i}] hour=${h.tm_hour} temp=${h.temp} humi=${h.humi}`));

    const found = history.find(h => h.tm_hour === targetHour);
    if (found) {
      console.log(`    ✓ 历史写入成功: hour=${targetHour} temp=${found.temp} humi=${found.humi}`);
    } else {
      console.log(`    ✗ 未找到 hour=${targetHour} 的历史！`);
    }

    // 7. 恢复时间
    const r2 = new Date();
    await syncTime(dp, r2.getFullYear(), r2.getMonth() + 1, r2.getDate(), r2.getHours(), r2.getMinutes(), r2.getSeconds());
    console.log('[7] 时间已恢复');

    // 8. 再读 Actual
    const after = await readActual(dp);
    console.log(`[8] 当前: ActualTemp=${after.temp}, ActualHumi=${after.humi}`);

    console.log('\n=== 结论 ===');
    console.log(found ? '✓ 历史保存正常' : '✗ 历史保存失败');

  } finally {
    msh.disconnect();
    await dp.disconnect(KEY).catch(() => {});
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(2); });
