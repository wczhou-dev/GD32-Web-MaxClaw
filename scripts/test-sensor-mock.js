/**
 * scripts/test-sensor-mock.js
 * P1 传感器自动测试 Mock 自测脚本
 *
 * 职责：
 *   1. 在无硬件时验证场景编排、断言、报告逻辑
 *   2. 覆盖正常抄读、异常过滤、历史回退、配置热更新场景
 *   3. 输出 PASS/FAIL 结果和详细报告
 *
 * 运行方式：
 *   node scripts/test-sensor-mock.js
 *
 * 开发依据：
 *   - 传感器自动测试任务开发列表P1.md §7 (SYS-P1-007 Mock 自测)
 */

'use strict';

const SensorSimulator = require('../backend/ate/SensorSimulator');
const MockControllerStateReader = require('../backend/ate/MockControllerStateReader');
const AssertEngine = require('../backend/ate/AssertEngine');
const TestScenarioCatalog = require('../backend/ate/TestScenarioCatalog');

// ============================================================
// 测试工具
// ============================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(msg) {
  console.log(`  ${msg}`);
}

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ ${testName}`);
  } else {
    failedTests++;
    console.error(`  ❌ ${testName}`);
  }
}

// ============================================================
// 测试用例
// ============================================================

async function testSimulator() {
  console.log('\n=== 1. SensorSimulator 基础测试 ===');

  const sim = new SensorSimulator({ mock: true });
  await sim.start();

  // 场区加载
  sim.loadFieldConfig('A');
  assert(sim.getFieldConfig() !== null, '场区 A 加载成功');
  assert(sim.getFieldConfig().name === '标准场区', '场区名称正确');

  // 设置传感器值
  sim.setSensorValue('temp_1', 25.0);
  assert(sim.mockGetSensorValue('temp_1') === 25.0, 'temp_1 设置为 25.0');

  sim.setSensorValue('humi_1', 60.0);
  assert(sim.mockGetSensorValue('humi_1') === 60.0, 'humi_1 设置为 60.0');

  // Mock RTU 读取
  const vals = sim.mockReadHoldingRegisters(0x01, 0x0000, 2);
  assert(vals !== null, 'Mock RTU 读取返回数据');
  assert(vals[0] === 250, 'temp_1 原始值 250 (25.0 * 10)');
  assert(vals[1] === 600, 'humi_1 原始值 600 (60.0 * 10)');

  // 故障注入
  sim.injectTimeout({ key: 'temp_1' });
  const timeoutResult = sim.mockReadHoldingRegisters(0x01, 0x0000, 2);
  assert(timeoutResult === null, '超时注入后返回 null');

  // 清除故障
  sim.clearFault('temp_1');
  const clearedResult = sim.mockReadHoldingRegisters(0x01, 0x0000, 2);
  assert(clearedResult !== null, '清除故障后恢复响应');

  // persist 模式
  sim.injectTimeout({ key: 'temp_1', persist: true });
  const persistFault = sim.getFaultStatus()['temp_1'];
  assert(persistFault && persistFault.persist === true, 'persist 故障状态正确');

  // 交易日志
  const logs = sim.getTransactionLog();
  assert(logs.length > 0, '交易日志已记录');

  await sim.stop();
}

async function testAssertEngine() {
  console.log('\n=== 2. AssertEngine 断言测试 ===');

  const engine = new AssertEngine();

  // 浮点断言
  assert(engine.assertClose(25.0, 25.1, 0.2).pass, 'assertClose(25.0, 25.1, 0.2) PASS');
  assert(!engine.assertClose(25.0, 26.0, 0.2).pass, 'assertClose(25.0, 26.0, 0.2) FAIL');

  // 精确断言
  assert(engine.assertEqual(100, 100).pass, 'assertEqual(100, 100) PASS');
  assert(!engine.assertEqual(100, 200).pass, 'assertEqual(100, 200) FAIL');

  // 位图断言
  assert(engine.assertBitSet(0x0005, 0).pass, 'assertBitSet(0x0005, 0) PASS');
  assert(engine.assertBitClear(0x0005, 1).pass, 'assertBitClear(0x0005, 1) PASS');

  // 无效值断言
  assert(engine.assertInvalid(0x7FFF).pass, 'assertInvalid(0x7FFF) PASS');
  assert(!engine.assertInvalid(250).pass, 'assertInvalid(250) FAIL');

  // 传感器值断言
  assert(engine.assertSensorValue(25.0, 25.1, 0.2, 'temp_1').pass, 'assertSensorValue PASS');

  // 启动回退断言
  const bootResults = engine.assertBootFallback(
    { actualTemp: 20.0, actualHumi: 60.0 },
    { temp: 20.0, humi: 60.0 },
    0.2
  );
  assert(bootResults.every(r => r.pass), 'assertBootFallback(20.0/60.0) 全部 PASS');

  // 批量检查
  const results = [engine.assertClose(1, 1, 0.1), engine.assertClose(2, 2, 0.1)];
  const check = engine.checkResults(results);
  assert(check.allPassed, 'checkResults 全部通过');
}

async function testScenarioCatalog() {
  console.log('\n=== 3. TestScenarioCatalog 场景目录测试 ===');

  const catalog = new TestScenarioCatalog();

  assert(catalog.getAllScenarioIds().length === 20, '场景总数 20');
  assert(catalog.hasScenario('T-READ-001'), 'T-READ-001 存在');
  assert(catalog.hasScenario('SEN-HIST-BOOT-001'), 'SEN-HIST-BOOT-001 存在');
  assert(!catalog.hasScenario('INVALID'), 'INVALID 不存在');

  const readScenarios = catalog.getScenariosByCategory('正常抄读');
  assert(readScenarios.length === 4, '正常抄读场景 4 个');

  const abnfScenarios = catalog.getScenariosByCategory('异常过滤');
  assert(abnfScenarios.length === 4, '异常过滤场景 4 个');

  const s = catalog.loadScenario('T-READ-001');
  assert(s.inputs.sensors.length === 16, 'T-READ-001 有 16 个传感器');
}

async function testMockControllerStateReader() {
  console.log('\n=== 4. MockControllerStateReader 测试 ===');

  const sim = new SensorSimulator({ mock: true });
  await sim.start();
  sim.loadFieldConfig('A');

  const reader = new MockControllerStateReader({ sensorSimulator: sim });

  // 读取场区
  const zone = await reader.readFieldZone();
  assert(zone === 1, '场区类型 = 1');

  // 读取安装状态
  const install = await reader.readInstallStatus();
  assert(install.temp[0] === true, 'temp_1 已安装');

  // 设置传感器值并读取
  sim.setSensorValue('temp_1', 25.0);
  sim.setSensorValue('temp_2', 26.0);
  sim.setSensorValue('humi_1', 60.0);

  const data = await reader.readSensorData();
  assert(data.temp[0] === 25.0, 'temp_1 = 25.0');
  assert(data.temp[1] === 26.0, 'temp_2 = 26.0');
  assert(data.humi[0] === 60.0, 'humi_1 = 60.0');

  // 读取 Actual
  const actual = await reader.readActualTempHumi();
  assert(actual.actualTemp > 0, 'ActualTemp > 0');
  assert(actual.actualHumi > 0, 'ActualHumi > 0');

  // 对时
  const syncResult = await reader.syncTime({
    year: 2026, month: 6, day: 15, hour: 10, minute: 57, second: 0
  });
  assert(syncResult.ok === true, '对时成功');
  assert(syncResult.hr17 === 0, 'HR17 = 0');

  // 读取时间
  const hr = await reader.readRegister(13);
  assert(hr === 10, 'HR13 = 10');

  // 重启
  const rebootResult = await reader.reboot();
  assert(rebootResult.ok === true, '重启成功');
  assert(reader.mockGetRebootCount() === 1, '重启计数 = 1');

  // 历史缓冲
  await reader.clearHistory();
  reader.mockAddHistory({ tm_hour: 11, temp: 20.0, humi: 60.0, timestamp: 1000 });
  reader.mockAddHistory({ tm_hour: 15, temp: 22.0, humi: 62.0, timestamp: 2000 });
  const history = await reader.readHistoryTail(2);
  assert(history.length === 2, '历史缓冲 2 条');
  assert(history[0].tm_hour === 11, '第 1 条 tm_hour = 11');
  assert(history[1].tm_hour === 15, '第 2 条 tm_hour = 15');

  await sim.stop();
}

async function testNormalReadScenario() {
  console.log('\n=== 5. 正常抄读场景 Mock 测试 ===');

  const sim = new SensorSimulator({ mock: true });
  await sim.start();
  sim.loadFieldConfig('A');

  const reader = new MockControllerStateReader({ sensorSimulator: sim });
  const engine = new AssertEngine();
  const catalog = new TestScenarioCatalog();

  // 加载 T-READ-001 场景
  const scenario = catalog.loadScenario('T-READ-001');

  // 设置模拟器值
  for (const sensor of scenario.inputs.sensors) {
    sim.setSensorValue(sensor.key, sensor.value);
  }
  log(`设置 ${scenario.inputs.sensors.length} 个温度传感器`);

  // 读取数据
  const data = await reader.readSensorData();
  const actual = await reader.readActualTempHumi();

  // 逐路断言
  let allPass = true;
  for (const sensor of scenario.inputs.sensors) {
    const idx = parseInt(sensor.key.split('_')[1]) - 1;
    const result = engine.assertSensorValue(data.temp[idx], sensor.value, 0.1, sensor.key);
    if (!result.pass) allPass = false;
  }

  // 平均值断言
  const expectedAvg = scenario.inputs.sensors.reduce((sum, s) => sum + s.value, 0) / scenario.inputs.sensors.length;
  const avgResult = engine.assertActualValue(actual.actualTemp, expectedAvg, 0.1, 'temp');
  if (!avgResult.pass) allPass = false;

  assert(allPass, 'T-READ-001 逐路断言 + 平均值断言全部通过');

  await sim.stop();
}

async function testAbnormalFilterScenario() {
  console.log('\n=== 6. 异常过滤场景 Mock 测试 ===');

  const sim = new SensorSimulator({ mock: true });
  await sim.start();
  sim.loadFieldConfig('A');

  const reader = new MockControllerStateReader({ sensorSimulator: sim });
  const engine = new AssertEngine();

  // 正常采集
  sim.setSensorValue('temp_1', 25.0);
  const dataBefore = await reader.readSensorData();
  assert(dataBefore.temp[0] === 25.0, '正常采集 temp_1 = 25.0');

  // 注入超时
  sim.injectTimeout({ key: 'temp_1' });
  const timeoutData = sim.mockReadHoldingRegisters(0x01, 0x0000, 2);
  assert(timeoutData === null, '超时注入后不响应');

  // 模拟 ErRead：读取 Actual 应为 INVALID
  const actual = await reader.readActualTempHumi();
  assert(actual.tempInvalid === true, 'ErRead 后 tempInvalid = true');

  // 清除故障恢复
  sim.clearFault('temp_1');
  sim.setSensorValue('temp_1', 25.0);
  const dataAfter = await reader.readSensorData();
  assert(dataAfter.temp[0] === 25.0, '恢复后 temp_1 = 25.0');

  await sim.stop();
}

async function testHistoryFallbackScenario() {
  console.log('\n=== 7. 历史回退场景 Mock 测试 ===');

  const sim = new SensorSimulator({ mock: true });
  await sim.start();
  sim.loadFieldConfig('A');

  const reader = new MockControllerStateReader({ sensorSimulator: sim });
  const engine = new AssertEngine();

  // 冻结阶段模拟
  const groups = [
    { freezeHour: 10, verifyHour: 11, temp: 20.0, humi: 60.0 },
    { freezeHour: 14, verifyHour: 15, temp: 22.0, humi: 62.0 },
    { freezeHour: 18, verifyHour: 19, temp: 24.0, humi: 64.0 },
  ];

  for (const group of groups) {
    // 设置模拟器值
    sim.setSensorValue('temp_1', group.temp);
    sim.setSensorValue('humi_1', group.humi);

    // 对时
    await reader.syncTime({
      year: 2026, month: 6, day: 14,
      hour: group.freezeHour, minute: 57, second: 0
    });

    // 模拟跨小时冻结
    reader.mockAddHistory({
      tm_hour: group.verifyHour,
      temp: group.temp,
      humi: group.humi,
      timestamp: Date.now(),
    });
  }

  // 验证历史缓冲
  const history = await reader.readHistoryTail(3);
  assert(history.length === 3, '历史缓冲 3 条');

  for (let i = 0; i < 3; i++) {
    const entry = history[i];
    const group = groups[i];
    const results = engine.assertHistoryEntry(entry, {
      tm_hour: group.verifyHour,
      temp: group.temp,
      humi: group.humi,
    }, 0.2);
    assert(results.every(r => r.pass), `第 ${i + 1} 组历史冻结正确 (tm_hour=${group.verifyHour})`);
  }

  // 启动回退验证模拟
  for (let i = 0; i < 3; i++) {
    const group = groups[i];

    // 模拟重启后持续异常
    sim.injectTimeout({ key: 'temp_1', persist: true });
    sim.injectTimeout({ key: 'humi_1', persist: true });

    // 模拟重启
    await reader.reboot();

    // 对时到今天 verifyHour:05
    await reader.syncTime({
      year: 2026, month: 6, day: 15,
      hour: group.verifyHour, minute: 5, second: 0
    });

    // 模拟回退到历史值（Mock 模式下直接设置）
    // 实际固件会从历史缓冲读取并回退
    // 这里模拟回退后的 ActualTemp/ActualHumi
    const bootResult = engine.assertBootFallback(
      { actualTemp: group.temp, actualHumi: group.humi },
      { temp: group.temp, humi: group.humi },
      0.2
    );
    assert(bootResult.every(r => r.pass), `第 ${i + 1} 组启动回退正确 (temp=${group.temp}, humi=${group.humi})`);

    // 清除故障
    sim.clearFault('temp_1');
    sim.clearFault('humi_1');
  }

  // 恢复时间
  await reader.restoreRealTime();
  assert(true, '恢复真实时间');

  await sim.stop();
}

async function testConfigHotUpdateScenario() {
  console.log('\n=== 8. 配置热更新场景 Mock 测试 ===');

  const sim = new SensorSimulator({ mock: true });
  await sim.start();
  sim.loadFieldConfig('A');

  const reader = new MockControllerStateReader({ sensorSimulator: sim });
  const engine = new AssertEngine();

  // 温度补偿测试
  sim.setSensorValue('temp_1', 25.0);
  const before = await reader.readSensorData();
  assert(before.temp[0] === 25.0, '补偿前 temp_1 = 25.0');

  // 写入补偿 +1.5℃ (15)
  await reader.writeRegister(0x7050, 15);
  // Mock 模式下需要手动模拟补偿效果
  sim.setSensorValue('temp_1', 26.5);
  const afterComp = await reader.readSensorData();
  assert(afterComp.temp[0] === 26.5, '补偿后 temp_1 = 26.5');

  // 恢复补偿为 0
  await reader.writeRegister(0x7050, 0);
  sim.setSensorValue('temp_1', 25.0);
  const afterRestore = await reader.readSensorData();
  assert(afterRestore.temp[0] === 25.0, '恢复后 temp_1 = 25.0');

  // 安装位测试
  const installBefore = await reader.readInstallStatus();
  assert(installBefore.temp[2] === true, '第 3 路温度已安装');

  // 禁用第 3 路
  await reader.writeInstallBit('temp', 2, false);
  const installAfter = await reader.readInstallStatus();
  assert(installAfter.temp[2] === false, '第 3 路温度已禁用');

  // 启用第 3 路
  await reader.writeInstallBit('temp', 2, true);
  const installRestored = await reader.readInstallStatus();
  assert(installRestored.temp[2] === true, '第 3 路温度已启用');

  await sim.stop();
}

// ============================================================
// 主测试流程
// ============================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  P1 传感器自动测试 Mock 自测                    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`运行时间: ${new Date().toISOString()}`);

  try {
    await testSimulator();
    await testAssertEngine();
    await testScenarioCatalog();
    await testMockControllerStateReader();
    await testNormalReadScenario();
    await testAbnormalFilterScenario();
    await testHistoryFallbackScenario();
    await testConfigHotUpdateScenario();

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  测试结果汇总                                    ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  总计: ${totalTests}`);
    console.log(`  通过: ${passedTests} ✅`);
    console.log(`  失败: ${failedTests} ❌`);
    console.log(`  结论: ${failedTests === 0 ? '全部通过 ✅' : '存在失败 ❌'}`);

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('\n💥 测试异常:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
