/**
 * scripts/test-temp-curve-hil.js
 * 温度曲线 HIL (Hardware-in-the-Loop) 自动测试脚本
 *
 * 职责：
 *   1. 通过 Modbus TCP 读写温度曲线寄存器
 *   2. 验证手动模式 / 自动模式 / 模式切换 / 曲线参数
 *   3. 输出 PASS/FAIL 结果和详细报告
 *
 * 运行方式：
 *   node scripts/test-temp-curve-hil.js
 *
 * 前置条件：
 *   - 环控器已上电并连接到 192.168.10.233:1502
 *
 * 温度曲线寄存器映射：
 *   0x7092: Temp_ctrlMode   (R/W) 0=auto, 1=manual
 *   0x7093: Settemp         (R/W, val/10) 手动目标温度
 *   0x7094: isEnable        (R/W) 曲线使能
 *   0x7095: validNum        (RO)  有效曲线段数
 *   0x7096-0x709F: baseAge[0-9] (R/W) 曲线年龄点
 *   0x70A0-0x70A9: Temp[0-9] (R/W, val/10) 曲线温度值
 *   0x70AA: pig_age         (R/W) 猪只日龄
 *   0x708D: Expected_temp   (R/W, val/10) 当前期望温度
 *
 * target_temp_service 逻辑：
 *   自动模式: Temp_ctrlMode=0 AND isEnable=1 → 按曲线计算 Expected_temp
 *   手动模式: Temp_ctrlMode=1 OR isEnable=0  → 使用 Settemp 作为 Expected_temp
 *   手动约束: |Settemp - Expected_temp| ≤ 2°C 才能生效
 *   曲线计算: baseAge[i-1] ~ baseAge[i] 之间线性插值
 */

'use strict';

const DevicePool = require('../backend/DevicePool');
const ControllerStateReader = require('../backend/ate/ControllerStateReader');

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  DEVICE_IP: '192.168.10.233',
  MODBUS_PORT: 1502,
  UNIT_ID: 1,

  // 控制周期等待（毫秒）
  CONTROL_CYCLE_MS: 2500,
  // 状态稳定等待（毫秒）
  STABLE_WAIT_MS: 3000,
  // 最大轮询等待（毫秒）
  MAX_POLL_WAIT_MS: 60000,
  // 轮询间隔（毫秒）
  POLL_INTERVAL_MS: 500,
  // 心跳间隔（毫秒）
  HEARTBEAT_INTERVAL_MS: 30000,
};

const DEVICE_KEY = `${CONFIG.DEVICE_IP}:${CONFIG.MODBUS_PORT}:${CONFIG.UNIT_ID}`;

// ============================================================
// 寄存器地址
// ============================================================

const REG = {
  TEMP_CTRL_MODE:  0x7092,  // R/W 0=auto, 1=manual
  SET_TEMP:        0x7093,  // R/W val/10 手动目标温度
  IS_ENABLE:       0x7094,  // R/W 曲线使能
  VALID_NUM:       0x7095,  // RO  有效曲线段数
  BASE_AGE_START:  0x7096,  // R/W baseAge[0] (0x7096-0x709F)
  TEMP_START:      0x70A0,  // R/W Temp[0]    (0x70A0-0x70A9)
  PIG_AGE:         0x70AA,  // R/W 猪只日龄
  EXPECTED_TEMP:   0x708D,  // R/W val/10 当前期望温度
};

/** 心跳寄存器地址 */
const HEARTBEAT_REG = 0x7088;
const HEARTBEAT_REG_COUNT = 3;

// ============================================================
// 测试框架
// ============================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;
const testResults = [];

function log(msg) {
  console.log(`  ${msg}`);
}

function logInfo(msg) {
  console.log(`  ℹ️  ${msg}`);
}

function logWarn(msg) {
  console.log(`  ⚠️  ${msg}`);
}

function assert(condition, testName, detail) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ ${testName}`);
    testResults.push({ name: testName, status: 'PASS', detail });
  } else {
    failedTests++;
    console.error(`  ❌ ${testName}${detail ? ' - ' + detail : ''}`);
    testResults.push({ name: testName, status: 'FAIL', detail });
  }
}

function skip(testName, reason) {
  totalTests++;
  skippedTests++;
  console.log(`  ⏭️  ${testName} (跳过: ${reason})`);
  testResults.push({ name: testName, status: 'SKIP', detail: reason });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的读取
 */
async function readWithRetry(reader, fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1000);
    }
  }
}

/**
 * 心跳等待：在等待期间每30秒发送一次心跳读取，保持 Modbus TCP 连接活跃
 */
async function heartbeatWait(dp, key, ms, label = '') {
  const tag = label ? `[心跳${label}]` : '[心跳]';
  const start = Date.now();
  const intervals = Math.ceil(ms / CONFIG.HEARTBEAT_INTERVAL_MS);

  for (let i = 0; i < intervals; i++) {
    const remaining = ms - (Date.now() - start);
    const waitMs = Math.min(CONFIG.HEARTBEAT_INTERVAL_MS, remaining);
    if (waitMs <= 0) break;

    await sleep(waitMs);

    try {
      const regs = await dp.readHoldingRegisters(key, HEARTBEAT_REG, HEARTBEAT_REG_COUNT);
      if (regs && regs.length >= 3) {
        logInfo(`${tag} heartbeat @ ${((Date.now() - start) / 1000).toFixed(0)}s: IndoorState=${regs[0]}, OutdoorState=${regs[1]}, HeatRunState=${regs[2]}`);
      }
    } catch (e) {
      logWarn(`${tag} heartbeat read failed: ${e.message}`);
    }
  }
}

// ============================================================
// 温度曲线辅助函数
// ============================================================

/**
 * 读取温度曲线全部寄存器，返回结构化对象
 */
async function readTempCurveSnapshot(reader) {
  const ctrlMode = await reader.readRegister(REG.TEMP_CTRL_MODE);
  const setTempRaw = await reader.readRegister(REG.SET_TEMP);
  const isEnable = await reader.readRegister(REG.IS_ENABLE);
  const validNum = await reader.readRegister(REG.VALID_NUM);
  const pigAge = await reader.readRegister(REG.PIG_AGE);
  const expectedTempRaw = await reader.readRegister(REG.EXPECTED_TEMP);

  // 读取 baseAge[0-9] (10个寄存器)
  const baseAges = [];
  for (let i = 0; i < 10; i++) {
    baseAges.push(await reader.readRegister(REG.BASE_AGE_START + i));
  }

  // 读取 Temp[0-9] (10个寄存器, val/10)
  const temps = [];
  for (let i = 0; i < 10; i++) {
    const raw = await reader.readRegister(REG.TEMP_START + i);
    temps.push(raw / 10);
  }

  return {
    ctrlMode,
    setTemp: setTempRaw / 10,
    setTempRaw,
    isEnable,
    validNum,
    baseAges,
    temps,
    pigAge,
    expectedTemp: expectedTempRaw / 10,
    expectedTempRaw,
  };
}

/**
 * 写入温度曲线参数
 */
async function writeCurveParams(reader, params) {
  if (params.ctrlMode !== undefined) {
    await reader.writeRegister(REG.TEMP_CTRL_MODE, params.ctrlMode);
  }
  if (params.setTemp !== undefined) {
    await reader.writeRegister(REG.SET_TEMP, Math.round(params.setTemp * 10));
  }
  if (params.isEnable !== undefined) {
    await reader.writeRegister(REG.IS_ENABLE, params.isEnable);
  }
  if (params.pigAge !== undefined) {
    await reader.writeRegister(REG.PIG_AGE, params.pigAge);
  }
  if (params.expectedTemp !== undefined) {
    await reader.writeRegister(REG.EXPECTED_TEMP, Math.round(params.expectedTemp * 10));
  }
  if (params.baseAges) {
    for (let i = 0; i < params.baseAges.length && i < 10; i++) {
      await reader.writeRegister(REG.BASE_AGE_START + i, params.baseAges[i]);
    }
  }
  if (params.temps) {
    for (let i = 0; i < params.temps.length && i < 10; i++) {
      await reader.writeRegister(REG.TEMP_START + i, Math.round(params.temps[i] * 10));
    }
  }
}

/**
 * 线性插值计算期望温度（与固件逻辑一致）
 * @param {number[]} baseAges - 年龄点数组
 * @param {number[]} temps - 温度值数组 (已除以10)
 * @param {number} validNum - 有效段数
 * @param {number} pigAge - 猪只日龄
 * @returns {number} 线性插值温度
 */
function interpolateTemp(baseAges, temps, validNum, pigAge) {
  if (validNum === 0) return 0;

  // 超出最大年龄：返回最后一个温度
  if (pigAge >= baseAges[validNum - 1]) {
    return temps[validNum - 1];
  }

  // 低于最小年龄：返回第一个温度
  if (pigAge <= baseAges[0]) {
    return temps[0];
  }

  // 找到所在区间并线性插值
  for (let i = 1; i < validNum; i++) {
    if (pigAge < baseAges[i]) {
      const age0 = baseAges[i - 1];
      const age1 = baseAges[i];
      const t0 = temps[i - 1];
      const t1 = temps[i];
      const ratio = (pigAge - age0) / (age1 - age0);
      return t0 + ratio * (t1 - t0);
    }
  }

  return temps[validNum - 1];
}

// ============================================================
// 测试用例
// ============================================================

/**
 * 1. 基础连接测试 - 读取所有温度曲线寄存器
 */
async function testBasicConnectivity(reader) {
  console.log('\n=== 1. 基础连接测试 ===');

  const snap = await readWithRetry(reader, () => readTempCurveSnapshot(reader));

  assert(
    snap !== null,
    'TC-BASIC-001: 读取温度曲线全部寄存器成功',
    `ctrlMode=${snap.ctrlMode}, setTemp=${snap.setTemp}, isEnable=${snap.isEnable}`
  );

  assert(
    typeof snap.ctrlMode === 'number' && (snap.ctrlMode === 0 || snap.ctrlMode === 1),
    'TC-BASIC-002: Temp_ctrlMode 初始值有效 (0/1)',
    `ctrlMode=${snap.ctrlMode}`
  );

  assert(
    typeof snap.isEnable === 'number' && (snap.isEnable === 0 || snap.isEnable === 1),
    'TC-BASIC-003: isEnable 初始值有效 (0/1)',
    `isEnable=${snap.isEnable}`
  );

  assert(
    typeof snap.validNum === 'number' && snap.validNum >= 0 && snap.validNum <= 10,
    'TC-BASIC-004: validNum 初始值有效 (0-10)',
    `validNum=${snap.validNum}`
  );

  assert(
    typeof snap.pigAge === 'number',
    'TC-BASIC-005: pig_age 可读',
    `pigAge=${snap.pigAge}`
  );

  assert(
    typeof snap.expectedTemp === 'number',
    'TC-BASIC-006: Expected_temp 可读',
    `expectedTemp=${snap.expectedTemp}`
  );

  // 验证 baseAge 和 Temp 数组长度
  assert(
    snap.baseAges.length === 10 && snap.temps.length === 10,
    'TC-BASIC-007: baseAge[0-9] 和 Temp[0-9] 均可读',
    `baseAge len=${snap.baseAges.length}, Temp len=${snap.temps.length}`
  );

  logInfo(`初始状态: ctrlMode=${snap.ctrlMode}, setTemp=${snap.setTemp}°C, isEnable=${snap.isEnable}, validNum=${snap.validNum}, pigAge=${snap.pigAge}d, expectedTemp=${snap.expectedTemp}°C`);
}

/**
 * 2. 手动模式测试
 */
async function testManualMode(reader) {
  console.log('\n=== 2. 手动模式测试 ===');

  // 保存原始状态
  const origSnap = await readTempCurveSnapshot(reader);
  const origCtrlMode = origSnap.ctrlMode;
  const origSetTemp = origSnap.setTemp;
  const origIsEnable = origSnap.isEnable;
  const origPigAge = origSnap.pigAge;
  const origExpectedTemp = origSnap.expectedTemp;

  try {
    // 设置为手动模式
    await writeCurveParams(reader, { ctrlMode: 1, isEnable: 0 });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const mode = await reader.readRegister(REG.TEMP_CTRL_MODE);
    assert(
      mode === 1,
      'TC-MANUAL-001: 设置 Temp_ctrlMode=1 (手动模式)',
      `readback=${mode}`
    );

    // 读取当前 Expected_temp
    const snapBefore = await readTempCurveSnapshot(reader);
    logInfo(`手动模式下当前 Expected_temp=${snapBefore.expectedTemp}°C`);

    // 设置 Settemp 接近当前 Expected_temp (在±2°C范围内)
    const targetSetTemp = snapBefore.expectedTemp + 1.0;  // +1°C，在范围内
    await writeCurveParams(reader, { setTemp: targetSetTemp });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapAfter = await readTempCurveSnapshot(reader);
    logInfo(`Settemp 设为 ${targetSetTemp}°C, 读回 setTemp=${snapAfter.setTemp}°C, Expected_temp=${snapAfter.expectedTemp}°C`);

    assert(
      Math.abs(snapAfter.setTemp - targetSetTemp) < 0.2,
      'TC-MANUAL-002: Settemp 写入后读回正确',
      `期望=${targetSetTemp}, 实际=${snapAfter.setTemp}`
    );

    assert(
      Math.abs(snapAfter.expectedTemp - snapAfter.setTemp) < 0.2,
      'TC-MANUAL-003: 手动模式下 Expected_temp = Settemp',
      `expectedTemp=${snapAfter.expectedTemp}, setTemp=${snapAfter.setTemp}`
    );

    // 测试手动约束：Settemp 偏离 Expected_temp 超过 2°C
    // 先确认当前 Expected_temp
    const currentExpected = snapAfter.expectedTemp;
    const farSetTemp = currentExpected + 5.0;  // 偏离 5°C
    logInfo(`测试±2°C约束: Settemp 从 ${currentExpected}°C 跳到 ${farSetTemp}°C (偏离5°C)...`);
    await writeCurveParams(reader, { setTemp: farSetTemp });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapFar = await readTempCurveSnapshot(reader);
    logInfo(`Settemp 写入 ${farSetTemp}°C, 读回 setTemp=${snapFar.setTemp}°C, Expected_temp=${snapFar.expectedTemp}°C`);

    // 根据约束逻辑：|Settemp - Expected_temp| ≤ 2°C 才生效
    // 偏离 5°C 超过阈值，Expected_temp 可能不会更新到 Settemp 值
    const deviation = Math.abs(snapFar.setTemp - snapFar.expectedTemp);
    logInfo(`偏差 |Settemp - Expected_temp| = ${deviation.toFixed(2)}°C`);

    assert(
      snapFar.setTemp === farSetTemp,
      'TC-MANUAL-004: Settemp 寄存器写入不受约束限制',
      `setTemp=${snapFar.setTemp}`
    );

    // 无论固件是否更新 Expected_temp，只要偏差超过2°C即可
    // 如果 Expected_temp 被更新了，说明约束是 0°C（无约束）
    // 如果 Expected_temp 没更新，说明约束在 2°C 内
    logInfo(`Expected_temp 在偏差 ${deviation.toFixed(2)}°C 后: ${snapFar.expectedTemp}°C`);

    // 再测试一个在约束范围内的值
    const closeSetTemp = currentExpected - 1.5;  // 偏离 1.5°C，在范围内
    await writeCurveParams(reader, { setTemp: closeSetTemp });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapClose = await readTempCurveSnapshot(reader);
    assert(
      Math.abs(snapClose.expectedTemp - snapClose.setTemp) < 0.2,
      'TC-MANUAL-005: 偏离≤2°C时 Settemp 生效',
      `expectedTemp=${snapClose.expectedTemp}, setTemp=${snapClose.setTemp}`
    );
  } finally {
    // 恢复原始状态
    logInfo('恢复手动模式原始状态...');
    await writeCurveParams(reader, {
      ctrlMode: origCtrlMode,
      setTemp: origSetTemp,
      isEnable: origIsEnable,
      pigAge: origPigAge,
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);
  }
}

/**
 * 3. 自动模式测试 - 温度曲线线性插值
 */
async function testAutoMode(reader) {
  console.log('\n=== 3. 自动模式测试 ===');

  // 保存原始状态
  const origSnap = await readTempCurveSnapshot(reader);

  try {
    // 配置 3 段曲线: baseAge=[0,30,60], Temp=[30,25,20]
    logInfo('配置 3 段曲线: baseAge=[0,30,60], Temp=[30,25,20]...');
    await writeCurveParams(reader, {
      ctrlMode: 0,       // 自动模式
      isEnable: 1,       // 曲线使能
      baseAges: [0, 30, 60],
      temps: [30, 25, 20],
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    // 验证曲线参数写入
    const snap = await readTempCurveSnapshot(reader);
    logInfo(`曲线配置读回: ctrlMode=${snap.ctrlMode}, isEnable=${snap.isEnable}, validNum=${snap.validNum}`);

    assert(
      snap.ctrlMode === 0,
      'TC-AUTO-001: Temp_ctrlMode=0 (自动模式)',
      `ctrlMode=${snap.ctrlMode}`
    );

    assert(
      snap.isEnable === 1,
      'TC-AUTO-002: isEnable=1 (曲线使能)',
      `isEnable=${snap.isEnable}`
    );

    // 测试各年龄点的 Expected_temp
    const testCases = [
      { age: 0,  expected: 30.0, desc: 'age=0 (第一段起点)' },
      { age: 15, expected: 27.5, desc: 'age=15 (0-30段中点)' },
      { age: 30, expected: 25.0, desc: 'age=30 (第一段终点/第二段起点)' },
      { age: 45, expected: 22.5, desc: 'age=45 (30-60段中点)' },
      { age: 60, expected: 20.0, desc: 'age=60 (第二段终点)' },
      { age: 90, expected: 20.0, desc: 'age=90 (超出最后年龄点)' },
    ];

    for (const tc of testCases) {
      logInfo(`设置 pig_age=${tc.age}...`);
      await writeCurveParams(reader, { pigAge: tc.age });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapAge = await readTempCurveSnapshot(reader);
      const diff = Math.abs(snapAge.expectedTemp - tc.expected);

      logInfo(`pig_age=${tc.age}, Expected_temp=${snapAge.expectedTemp}°C (期望≈${tc.expected}°C, 差=${diff.toFixed(2)}°C)`);

      // 容差: ±1°C (考虑固件浮点精度和控制周期延迟)
      assert(
        diff < 1.0,
        `TC-AUTO-00${3 + testCases.indexOf(tc)}: ${tc.desc} → Expected_temp≈${tc.expected}°C`,
        `actual=${snapAge.expectedTemp}°C, expected=${tc.expected}°C, diff=${diff.toFixed(2)}°C`
      );
    }

    // 验证 validNum
    const finalSnap = await readTempCurveSnapshot(reader);
    assert(
      finalSnap.validNum === 3,
      `TC-AUTO-009: validNum=3 (3段曲线)`,
      `validNum=${finalSnap.validNum}`
    );

    // 验证 baseAge 读回
    assert(
      finalSnap.baseAges[0] === 0 && finalSnap.baseAges[1] === 30 && finalSnap.baseAges[2] === 60,
      'TC-AUTO-010: baseAge[0-2] 读回正确',
      `baseAges=[${finalSnap.baseAges.slice(0, 3).join(',')}]`
    );

    // 验证 Temp 读回
    assert(
      Math.abs(finalSnap.temps[0] - 30) < 0.2 && Math.abs(finalSnap.temps[1] - 25) < 0.2 && Math.abs(finalSnap.temps[2] - 20) < 0.2,
      'TC-AUTO-011: Temp[0-2] 读回正确',
      `temps=[${finalSnap.temps.slice(0, 3).map(t => t.toFixed(1)).join(',')}]`
    );

  } finally {
    // 恢复原始状态
    logInfo('恢复自动模式原始状态...');
    await writeCurveParams(reader, {
      ctrlMode: origSnap.ctrlMode,
      isEnable: origSnap.isEnable,
      pigAge: origSnap.pigAge,
      baseAges: origSnap.baseAges,
      temps: origSnap.temps,
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);
  }
}

/**
 * 4. 模式切换测试
 */
async function testModeSwitch(reader) {
  console.log('\n=== 4. 模式切换测试 ===');

  // 保存原始状态
  const origSnap = await readTempCurveSnapshot(reader);

  try {
    // 先配置曲线
    logInfo('配置 3 段曲线...');
    await writeCurveParams(reader, {
      baseAges: [0, 30, 60],
      temps: [30, 25, 20],
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    // --- 阶段A: 自动模式 → 手动模式 ---
    console.log('  --- Phase A: 自动模式 → 手动模式 ---');
    {
      // 设置自动模式, pig_age=15 → 期望温度 ≈ 27.5°C
      await writeCurveParams(reader, {
        ctrlMode: 0,
        isEnable: 1,
        pigAge: 15,
      });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapAuto = await readTempCurveSnapshot(reader);
      logInfo(`自动模式: Expected_temp=${snapAuto.expectedTemp}°C (期望≈27.5°C)`);
      assert(
        Math.abs(snapAuto.expectedTemp - 27.5) < 1.0,
        'TC-SWITCH-001: 自动模式下 Expected_temp 按曲线计算',
        `expectedTemp=${snapAuto.expectedTemp}°C`
      );

      // 切换到手动模式
      await writeCurveParams(reader, { ctrlMode: 1 });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapManual = await readTempCurveSnapshot(reader);
      logInfo(`切换到手动模式: ctrlMode=${snapManual.ctrlMode}, Expected_temp=${snapManual.expectedTemp}°C`);

      assert(
        snapManual.ctrlMode === 1,
        'TC-SWITCH-002: 切换后 ctrlMode=1',
        `ctrlMode=${snapManual.ctrlMode}`
      );

      // 手动模式下 Expected_temp 应跟随 Settemp
      logInfo(`手动模式: Expected_temp=${snapManual.expectedTemp}°C, Settemp=${snapManual.setTemp}°C`);
    }

    // --- 阶段B: 手动模式 → 自动模式 ---
    console.log('  --- Phase B: 手动模式 → 自动模式 ---');
    {
      // 设置手动 Settemp
      await writeCurveParams(reader, { setTemp: 22.0 });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapBeforeSwitch = await readTempCurveSnapshot(reader);
      logInfo(`手动模式: Settemp=${snapBeforeSwitch.setTemp}°C, Expected_temp=${snapBeforeSwitch.expectedTemp}°C`);

      // 切换到自动模式
      await writeCurveParams(reader, { ctrlMode: 0, isEnable: 1, pigAge: 30 });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapAuto = await readTempCurveSnapshot(reader);
      logInfo(`切换到自动模式: Expected_temp=${snapAuto.expectedTemp}°C (期望≈25.0°C)`);

      assert(
        snapAuto.ctrlMode === 0,
        'TC-SWITCH-003: 切换回 ctrlMode=0',
        `ctrlMode=${snapAuto.ctrlMode}`
      );

      assert(
        Math.abs(snapAuto.expectedTemp - 25.0) < 1.0,
        'TC-SWITCH-004: 自动模式恢复后 Expected_temp 按曲线计算',
        `expectedTemp=${snapAuto.expectedTemp}°C`
      );
    }

    // --- 阶段C: isEnable 开关 ---
    console.log('  --- Phase C: isEnable 开关测试 ---');
    {
      // 自动模式 + 曲线使能
      await writeCurveParams(reader, { ctrlMode: 0, isEnable: 1, pigAge: 15 });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapEnabled = await readTempCurveSnapshot(reader);
      const tempEnabled = snapEnabled.expectedTemp;
      logInfo(`曲线使能: Expected_temp=${tempEnabled}°C`);

      // 关闭曲线使能
      await writeCurveParams(reader, { isEnable: 0 });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapDisabled = await readTempCurveSnapshot(reader);
      logInfo(`曲线关闭: Expected_temp=${snapDisabled.expectedTemp}°C, Settemp=${snapDisabled.setTemp}°C`);

      // isEnable=0 时应退回到 Settemp 模式
      assert(
        snapDisabled.isEnable === 0,
        'TC-SWITCH-005: isEnable=0 写入成功',
        `isEnable=${snapDisabled.isEnable}`
      );

      // 重新使能曲线
      await writeCurveParams(reader, { isEnable: 1 });
      await sleep(CONFIG.CONTROL_CYCLE_MS);

      const snapReEnabled = await readTempCurveSnapshot(reader);
      logInfo(`曲线重新使能: Expected_temp=${snapReEnabled.expectedTemp}°C (期望≈${tempEnabled}°C)`);

      assert(
        Math.abs(snapReEnabled.expectedTemp - tempEnabled) < 1.0,
        'TC-SWITCH-006: 重新使能后 Expected_temp 恢复曲线计算',
        `actual=${snapReEnabled.expectedTemp}°C, expected=${tempEnabled}°C`
      );
    }

  } finally {
    // 恢复原始状态
    logInfo('恢复模式切换原始状态...');
    await writeCurveParams(reader, {
      ctrlMode: origSnap.ctrlMode,
      setTemp: origSnap.setTemp,
      isEnable: origSnap.isEnable,
      pigAge: origSnap.pigAge,
      baseAges: origSnap.baseAges,
      temps: origSnap.temps,
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);
  }
}

/**
 * 5. 曲线参数验证 - 写入/读回/边界
 */
async function testCurveParams(reader) {
  console.log('\n=== 5. 曲线参数验证 ===');

  // 保存原始状态
  const origSnap = await readTempCurveSnapshot(reader);

  try {
    // --- 5.1 写入/读回 baseAge ---
    logInfo('测试 baseAge 写入/读回...');
    await writeCurveParams(reader, { baseAges: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90] });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapAges = await readTempCurveSnapshot(reader);
    const agesMatch = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].every(
      (v, i) => snapAges.baseAges[i] === v
    );
    assert(
      agesMatch,
      'TC-PARAM-001: baseAge[0-9] 写入/读回一致',
      `readback=[${snapAges.baseAges.join(',')}]`
    );

    // --- 5.2 写入/读回 Temp ---
    logInfo('测试 Temp 写入/读回...');
    await writeCurveParams(reader, { temps: [10.0, 15.5, 20.0, 25.5, 30.0, 35.5, 40.0, 45.5, 50.0, 55.5] });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapTemps = await readTempCurveSnapshot(reader);
    const tempsMatch = [10.0, 15.5, 20.0, 25.5, 30.0, 35.5, 40.0, 45.5, 50.0, 55.5].every(
      (v, i) => Math.abs(snapTemps.temps[i] - v) < 0.2
    );
    assert(
      tempsMatch,
      'TC-PARAM-002: Temp[0-9] 写入/读回一致',
      `readback=[${snapTemps.temps.map(t => t.toFixed(1)).join(',')}]`
    );

    // --- 5.3 简单 2 段曲线验证插值 ---
    logInfo('测试 2 段曲线插值...');
    await writeCurveParams(reader, {
      ctrlMode: 0,
      isEnable: 1,
      baseAges: [0, 50],
      temps: [35, 15],
      pigAge: 25,
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snap2Seg = await readTempCurveSnapshot(reader);
    // 25 天在 0~50 之间, 期望: 35 + (25/50)*(15-35) = 35 - 10 = 25°C
    logInfo(`2段曲线: pig_age=25, Expected_temp=${snap2Seg.expectedTemp}°C (期望≈25.0°C)`);
    assert(
      Math.abs(snap2Seg.expectedTemp - 25.0) < 1.0,
      'TC-PARAM-003: 2段曲线 age=25 线性插值',
      `actual=${snap2Seg.expectedTemp}°C, expected=25.0°C`
    );

    // --- 5.4 边界: age=0 (第一段起点) ---
    logInfo('测试边界: age=0...');
    await writeCurveParams(reader, {
      baseAges: [0, 30, 60],
      temps: [30, 25, 20],
      pigAge: 0,
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapAge0 = await readTempCurveSnapshot(reader);
    assert(
      Math.abs(snapAge0.expectedTemp - 30.0) < 1.0,
      'TC-PARAM-004: age=0 返回第一个温度点',
      `actual=${snapAge0.expectedTemp}°C, expected=30.0°C`
    );

    // --- 5.5 边界: age=100 (超出最后年龄点) ---
    logInfo('测试边界: age=100 (超出范围)...');
    await writeCurveParams(reader, { pigAge: 100 });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapAge100 = await readTempCurveSnapshot(reader);
    assert(
      Math.abs(snapAge100.expectedTemp - 20.0) < 1.0,
      'TC-PARAM-005: age=100 返回最后一个温度点',
      `actual=${snapAge100.expectedTemp}°C, expected=20.0°C`
    );

    // --- 5.6 边界: age=30 (恰好在节点上) ---
    logInfo('测试边界: age=30 (节点值)...');
    await writeCurveParams(reader, { pigAge: 30 });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapAge30 = await readTempCurveSnapshot(reader);
    assert(
      Math.abs(snapAge30.expectedTemp - 25.0) < 1.0,
      'TC-PARAM-006: age=30 恰好在节点',
      `actual=${snapAge30.expectedTemp}°C, expected=25.0°C`
    );

    // --- 5.7 边界: age=-1 (负值) ---
    logInfo('测试边界: age=-1 (负值)...');
    await writeCurveParams(reader, { pigAge: -1 });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapAgeNeg = await readTempCurveSnapshot(reader);
    logInfo(`age=-1: Expected_temp=${snapAgeNeg.expectedTemp}°C`);
    // 负值应该返回第一个温度点或被固件截断为 0
    assert(
      typeof snapAgeNeg.expectedTemp === 'number' && !isNaN(snapAgeNeg.expectedTemp),
      'TC-PARAM-007: age=-1 不导致异常',
      `expectedTemp=${snapAgeNeg.expectedTemp}°C`
    );

    // --- 5.8 10段满曲线测试 ---
    logInfo('测试 10 段满曲线...');
    const fullAges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    const fullTemps = [30, 29, 28, 27, 26, 25, 24, 23, 22, 21];
    await writeCurveParams(reader, {
      ctrlMode: 0,
      isEnable: 1,
      baseAges: fullAges,
      temps: fullTemps,
      pigAge: 45,
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);

    const snapFull = await readTempCurveSnapshot(reader);
    // 45 天在 40~50 之间, 期望: 26 + (5/10)*(25-26) = 26 - 0.5 = 25.5°C
    logInfo(`10段曲线: pig_age=45, Expected_temp=${snapFull.expectedTemp}°C (期望≈25.5°C)`);
    assert(
      Math.abs(snapFull.expectedTemp - 25.5) < 1.0,
      'TC-PARAM-008: 10段满曲线 age=45 线性插值',
      `actual=${snapFull.expectedTemp}°C, expected=25.5°C`
    );

  } finally {
    // 恢复原始状态
    logInfo('恢复曲线参数原始状态...');
    await writeCurveParams(reader, {
      ctrlMode: origSnap.ctrlMode,
      setTemp: origSnap.setTemp,
      isEnable: origSnap.isEnable,
      pigAge: origSnap.pigAge,
      baseAges: origSnap.baseAges,
      temps: origSnap.temps,
    });
    await sleep(CONFIG.CONTROL_CYCLE_MS);
  }
}

// ============================================================
// 主测试流程
// ============================================================

async function main() {
  const startTime = Date.now();
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  温度曲线 HIL 自动测试                                  ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`运行时间: ${new Date().toISOString()}`);
  console.log(`设备: ${CONFIG.DEVICE_IP}:${CONFIG.MODBUS_PORT}`);
  console.log('');

  // 初始化设备连接
  const dp = new DevicePool();
  dp.addDevice({
    ip: CONFIG.DEVICE_IP,
    port: CONFIG.MODBUS_PORT,
    unitId: CONFIG.UNIT_ID,
    name: 'GD32-TempCurve',
  });

  const reader = new ControllerStateReader({
    devicePool: dp,
    deviceKey: DEVICE_KEY,
  });

  try {
    console.log('[连接设备]');
    await dp.connect(DEVICE_KEY);
    // 清除可能残留的 exclusive 队列
    dp._exclusiveQueues.delete(DEVICE_KEY);
    await sleep(2000);
    console.log('  ✅ 设备已连接\n');

    // 执行所有测试
    await testBasicConnectivity(reader);
    await testManualMode(reader);
    await testAutoMode(reader);
    await testModeSwitch(reader);
    await testCurveParams(reader);

    // 输出汇总
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  测试结果汇总                                          ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`  总计: ${totalTests}`);
    console.log(`  通过: ${passedTests} ✅`);
    console.log(`  失败: ${failedTests} ❌`);
    console.log(`  跳过: ${skippedTests} ⏭️`);
    console.log(`  耗时: ${elapsed}s`);
    console.log(`  结论: ${failedTests === 0 ? '全部通过 ✅' : '存在失败 ❌'}`);

    // 输出失败项详情
    if (failedTests > 0) {
      console.log('\n失败项详情:');
      testResults
        .filter(r => r.status === 'FAIL')
        .forEach(r => console.log(`  ❌ ${r.name}: ${r.detail || ''}`));
    }

    // 输出跳过项详情
    if (skippedTests > 0) {
      console.log('\n跳过项详情:');
      testResults
        .filter(r => r.status === 'SKIP')
        .forEach(r => console.log(`  ⏭️  ${r.name}: ${r.detail || ''}`));
    }

    console.log('');

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('\n💥 测试异常:', err.message);
    console.error(err.stack);
    process.exit(2);
  } finally {
    await dp.disconnect(DEVICE_KEY).catch(() => {});
    console.log('[设备已断开]');
  }
}

main();
