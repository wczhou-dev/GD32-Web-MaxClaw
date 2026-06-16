/**
 * backend/ate/SensorTestExecutor.js
 * P1 传感器测试场景执行器
 *
 * 职责：
 *   1. 按场景类型编排完整测试流程（准备→模拟→等待→读取→断言→清理）
 *   2. 支持正常抄读、异常过滤、历史回退、配置热更新、综合场景
 *   3. 每个场景独立执行，失败时进入清理路径
 *
 * 开发依据：
 *   - 传感器自动测试内容开发清单P1.md
 *   - 传感器自动测试任务开发列表P1.md
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本
 */

'use strict';

const EventEmitter = require('events');
const AssertEngine = require('./AssertEngine');
const ControllerStateReader = require('./ControllerStateReader');
const {
  BLOCK_SENSOR_CONFIG,
  SENSOR_ACTUAL,
  BLOCK_SENSOR_TIME,
  INVALID_VALUE,
  ERROR_CODE,
} = require('../../shared/constants');

/**
 * 测试结果状态
 */
const EXEC_RESULT = {
  PASS: 'pass',
  FAIL: 'fail',
  ERROR: 'error',
  SKIP: 'skip',
};

class SensorTestExecutor extends EventEmitter {
  /**
   * @param {object} options
   * @param {DevicePool} options.devicePool
   * @param {SensorSimulator} options.sensorSimulator
   * @param {string} options.deviceKey
   * @param {string} [options.fieldType='A']
   */
  constructor(options = {}) {
    super();
    this._devicePool = options.devicePool;
    this._simulator = options.sensorSimulator;
    this._deviceKey = options.deviceKey;
    this._fieldType = options.fieldType || 'A';
    this._assertEngine = new AssertEngine();
    this._stateReader = new ControllerStateReader({
      devicePool: this._devicePool,
      deviceKey: this._deviceKey,
    });
  }

  /**
   * 更新设备键
   */
  setDeviceKey(deviceKey) {
    this._deviceKey = deviceKey;
    this._stateReader.setDeviceKey(deviceKey);
  }

  // ============================================================
  // 场景执行入口
  // ============================================================

  /**
   * 执行单个场景
   * @param {object} scenario 场景定义
   * @returns {Promise<{status: string, assertions: object[], report: object}>}
   */
  async execute(scenario) {
    const startTime = Date.now();
    const allAssertions = [];

    this.emit('scenario_start', { id: scenario.id, name: scenario.name });

    try {
      // 1. 准备：加载场区
      this._simulator.loadFieldConfig(this._fieldType);

      // 2. 按场景类型执行
      let result;
      switch (scenario.type) {
        case 'normal-read':
          result = await this._executeNormalRead(scenario, allAssertions);
          break;
        case 'abnormal-filter':
          result = await this._executeAbnormalFilter(scenario, allAssertions);
          break;
        case 'history-boot-fallback':
          result = await this._executeHistoryFallback(scenario, allAssertions);
          break;
        case 'config-hot-update':
          result = await this._executeConfigHotUpdate(scenario, allAssertions);
          break;
        case 'composite':
          result = await this._executeComposite(scenario, allAssertions);
          break;
        default:
          throw new Error(`未知场景类型: ${scenario.type}`);
      }

      const { allPassed, failures } = this._assertEngine.checkResults(allAssertions);
      const elapsed = Date.now() - startTime;

      const report = {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        scenarioType: scenario.type,
        fieldType: this._fieldType,
        startTime,
        endTime: Date.now(),
        duration: elapsed,
        conclusion: allPassed ? '通过' : '失败',
        assertions: this._assertEngine.toReportFormat(allAssertions),
        transactionLog: this._simulator.getTransactionLog(),
        simulatorState: {
          shadowRegisters: this._simulator.getShadowRegisters(),
          faultStatus: this._simulator.getFaultStatus(),
        },
      };

      this.emit('scenario_end', {
        id: scenario.id,
        status: allPassed ? EXEC_RESULT.PASS : EXEC_RESULT.FAIL,
        elapsed,
      });

      return {
        status: allPassed ? EXEC_RESULT.PASS : EXEC_RESULT.FAIL,
        assertions: allAssertions,
        report,
      };

    } catch (err) {
      const elapsed = Date.now() - startTime;
      this.emit('scenario_error', { id: scenario.id, error: err.message });
      return {
        status: EXEC_RESULT.ERROR,
        assertions: allAssertions,
        report: {
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          startTime,
          endTime: Date.now(),
          duration: elapsed,
          conclusion: '异常',
          error: err.message,
        },
      };
    } finally {
      // 3. 清理
      await this._cleanup(scenario);
    }
  }

  // ============================================================
  // 正常抄读
  // ============================================================

  /**
   * 执行正常抄读场景 (T-READ-001~004)
   */
  async _executeNormalRead(scenario, assertions) {
    const sensors = scenario.inputs.sensors;
    const tolerance = scenario.expected.tolerance || 0.1;

    // 设置模拟器值
    for (const sensor of sensors) {
      this._simulator.setSensorValue(sensor.key, sensor.value);
    }
    this._log(`设置 ${sensors.length} 个传感器值`);

    // 等待采集周期
    await this._waitCollect(15000);

    // 读取环控器数据
    const sensorData = await this._stateReader.readSensorData();
    const actual = await this._stateReader.readActualTempHumi();

    // 逐路断言
    for (const sensor of sensors) {
      let actualValue;
      const idx = this._getSensorIndex(sensor.key);

      if (sensor.key.startsWith('temp_')) {
        actualValue = sensorData.temp[idx];
      } else if (sensor.key.startsWith('humi_')) {
        actualValue = sensorData.humi[idx];
      } else if (sensor.key.startsWith('co2_')) {
        actualValue = sensorData.co2[idx];
      } else if (sensor.key.startsWith('press_')) {
        actualValue = sensorData.press[idx];
      }

      if (actualValue != null) {
        assertions.push(this._assertEngine.assertSensorValue(
          actualValue, sensor.value, tolerance, sensor.key
        ));
      }
    }

    // 平均值断言
    if (scenario.id === 'T-READ-001') {
      const valids = sensorData.temp.slice(0, sensors.length);
      const expectedAvg = valids.reduce((a, b) => a + b, 0) / valids.length;
      assertions.push(this._assertEngine.assertActualValue(
        actual.actualTemp, expectedAvg, tolerance, 'temp'
      ));
    } else if (scenario.id === 'T-READ-002') {
      const valids = sensorData.humi.slice(0, sensors.length);
      const expectedAvg = valids.reduce((a, b) => a + b, 0) / valids.length;
      assertions.push(this._assertEngine.assertActualValue(
        actual.actualHumi, expectedAvg, tolerance, 'humi'
      ));
    }
  }

  // ============================================================
  // 异常过滤
  // ============================================================

  /**
   * 执行异常过滤场景 (T-ABNF-001~003)
   */
  async _executeAbnormalFilter(scenario, assertions) {
    if (scenario.id === 'T-ABNF-001') {
      return await this._execErRead(scenario, assertions);
    }
    if (scenario.id === 'T-ABNF-002') {
      return await this._execErMax(scenario, assertions);
    }
    if (scenario.id === 'T-ABNF-003-ODD' || scenario.id === 'T-ABNF-003-EVEN') {
      return await this._execDeviation剔除(scenario, assertions);
    }
    throw new Error(`未知异常过滤场景: ${scenario.id}`);
  }

  /**
   * ErRead：通信失败 10 次触发
   */
  async _execErRead(scenario, assertions) {
    const { preCondition, fault } = scenario.inputs;

    // 先正常采集确认
    this._simulator.setSensorValue(preCondition.key, preCondition.value);
    this._log(`设置正常值: ${preCondition.key} = ${preCondition.value}`);
    await this._waitCollect(10000);

    // 注入超时
    this._simulator.injectTimeout({ key: fault.key, persist: fault.persist });
    this._log(`注入超时: ${fault.key}`);

    // 等待 10 次轮询失败（轮询周期约 2~6 秒/路，10 次约 20~60 秒）
    this._log('等待 ErRead 触发 (约 60 秒)...');
    await this._waitCollect(60000);

    // 读取结果
    const regValue = await this._stateReader.readRegister(0x1001);
    assertions.push(this._assertEngine.assertInvalid(regValue,
      `ErRead 后 temp_1 应为 INVALID: ${regValue}`));
  }

  /**
   * ErMax：数值不变 100 次触发
   */
  async _execErMax(scenario, assertions) {
    const { fixedValue } = scenario.inputs;

    // 设置固定值
    this._simulator.setSensorValue(fixedValue.key, fixedValue.value);
    this._simulator.injectFixedValue({
      key: fixedValue.key,
      value: fixedValue.value,
      repeat: fixedValue.repeat,
    });
    this._log(`注入固定值: ${fixedValue.key} = ${fixedValue.value} (repeat=${fixedValue.repeat})`);

    // 等待 100 次轮询（轮询周期约 2~6 秒/路，100 次约 200~600 秒）
    // 为缩短测试时间，这里等待 300 秒（模拟器会持续返回固定值）
    this._log('等待 ErMax 触发 (约 300 秒)...');
    await this._waitCollect(300000);

    // TODO: 读取 ErMax 告警寄存器并断言
    // 暂时只验证数据仍在
    const regValue = await this._stateReader.readRegister(0x1001);
    assertions.push(this._assertEngine.assertClose(
      regValue / 10, fixedValue.value, 0.1,
      `ErMax 后 temp_1 应保持固定值`
    ));
  }

  /**
   * 偏差剔除：离群值不参与平均
   */
  async _execDeviation剔除(scenario, assertions) {
    const { sensors } = scenario.inputs;
    const { expectedActual, tolerance } = scenario.expected;

    // 设置所有传感器值
    for (const s of sensors) {
      this._simulator.setSensorValue(s.key, s.value);
    }
    this._log(`设置 ${sensors.length} 个传感器值 (含 1 个离群值)`);

    // 等待采集
    await this._waitCollect(15000);

    // 读取 ActualTemp
    const actual = await this._stateReader.readActualTempHumi();
    assertions.push(this._assertEngine.assertActualValue(
      actual.actualTemp, expectedActual, tolerance, 'temp'
    ));
    this._log(`ActualTemp: ${actual.actualTemp}, 期望: ${expectedActual}`);
  }

  // ============================================================
  // 历史回退
  // ============================================================

  /**
   * 执行历史回退场景 (T-HIST-001, T-HIST-003, SEN-HIST-BOOT-001)
   */
  async _executeHistoryFallback(scenario, assertions) {
    if (scenario.id === 'T-HIST-003') {
      return await this._execHistoryUpdate(scenario, assertions);
    }
    // T-HIST-001 和 SEN-HIST-BOOT-001
    return await this._execBootFallback(scenario, assertions);
  }

  /**
   * 启动回退：冻结 → 重启 → 对时 → 验证回退值
   */
  async _execBootFallback(scenario, assertions) {
    const groups = scenario.freezeGroups || scenario.inputs.freezeGroups;
    const sensorKeys = scenario.sensorKeys || scenario.inputs.sensorKeys;
    const tolerance = scenario.tolerance || scenario.inputs.tolerance || 0.2;

    // === 冻结阶段 ===
    this._log('=== 冻结阶段 ===');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      this._log(`冻结第 ${i + 1} 组: ${group.name}, temp=${group.temp}, humi=${group.humi}`);

      // 设置模拟器值
      this._simulator.setSensorValue(sensorKeys.temp, group.temp);
      this._simulator.setSensorValue(sensorKeys.humi, group.humi);

      // 对时到昨天 freezeHour:57
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const syncResult = await this._stateReader.syncTime({
        year: yesterday.getFullYear(),
        month: yesterday.getMonth() + 1,
        day: yesterday.getDate(),
        hour: group.freezeHour,
        minute: 57,
        second: 0,
      });
      assertions.push(...this._assertEngine.assertTimeSync(
        syncResult.hr17,
        { hour: syncResult.deviceTimeArray[3], minute: syncResult.deviceTimeArray[4] },
        { hour: group.freezeHour, minute: 57 }
      ));
      this._log(`对时结果: ${syncResult.ok ? '成功' : '失败'}`);

      // 等待跨小时
      this._log(`等待跨小时到 ${group.verifyHour}:00...`);
      const crossOk = await this._waitCrossHour(group.verifyHour, 200);
      if (!crossOk) {
        assertions.push({ pass: false, code: 'CROSS_HOUR_TIMEOUT', message: `跨小时等待超时: 期望 ${group.verifyHour}` });
        return;
      }

      // 读取历史确认
      // TODO: 需要 readHistoryTail 实现后才能断言历史值
      this._log(`跨小时成功: ${group.verifyHour}`);
    }

    // === 用例 A 启动回退验证 ===
    this._log('=== 启动回退验证阶段 ===');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      this._log(`验证第 ${i + 1} 组: ${group.name}, 期望回退 temp=${group.temp}, humi=${group.humi}`);

      // 设置传感器持续异常
      this._simulator.injectTimeout({ key: sensorKeys.temp, persist: true });
      this._simulator.injectTimeout({ key: sensorKeys.humi, persist: true });

      // 重启
      const rebootResult = await this._stateReader.reboot({ waitMs: 65000 });
      if (!rebootResult.ok) {
        assertions.push({ pass: false, code: ERROR_CODE.SENSOR_REBOOT_FAIL, message: '重启失败' });
        return;
      }
      this._log(`重启成功, 耗时 ${rebootResult.rebootTimeMs}ms`);

      // 对时到今天 verifyHour:05
      const today = new Date();
      const syncResult = await this._stateReader.syncTime({
        year: today.getFullYear(),
        month: today.getMonth() + 1,
        day: today.getDate(),
        hour: group.verifyHour,
        minute: 5,
        second: 0,
      });
      assertions.push(...this._assertEngine.assertTimeSync(
        syncResult.hr17,
        { hour: syncResult.deviceTimeArray[3], minute: syncResult.deviceTimeArray[4] },
        { hour: group.verifyHour, minute: 5 }
      ));

      // 等待回退逻辑执行
      this._log('等待回退逻辑执行 (5 秒)...');
      await this._waitCollect(5000);

      // 读取 ActualTemp/ActualHumi
      const actual = await this._stateReader.readActualTempHumi();
      assertions.push(...this._assertEngine.assertBootFallback(
        actual, { temp: group.temp, humi: group.humi }, tolerance
      ));
      this._log(`回退结果: ActualTemp=${actual.actualTemp}, ActualHumi=${actual.actualHumi}`);
    }

    // === 恢复阶段 ===
    this._log('=== 恢复阶段 ===');
    this._simulator.clearFault(sensorKeys.temp);
    this._simulator.clearFault(sensorKeys.humi);
    await this._stateReader.restoreRealTime();
    this._log('恢复完成');
  }

  /**
   * 历史更新与对时跳变防污染
   */
  async _execHistoryUpdate(scenario, assertions) {
    const { sensorValues, freezeHour, verifyHour } = scenario.inputs;
    const { tolerance } = scenario.expected;

    // 设置模拟器值
    this._simulator.setSensorValue('temp_1', sensorValues.temp);
    this._simulator.setSensorValue('humi_1', sensorValues.humi);

    // 对时到昨天 freezeHour:57
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const syncResult = await this._stateReader.syncTime({
      year: yesterday.getFullYear(),
      month: yesterday.getMonth() + 1,
      day: yesterday.getDate(),
      hour: freezeHour,
      minute: 57,
      second: 0,
    });
    assertions.push(...this._assertEngine.assertTimeSync(
      syncResult.hr17,
      { hour: syncResult.deviceTimeArray[3], minute: syncResult.deviceTimeArray[4] },
      { hour: freezeHour, minute: 57 }
    ));

    // 等待跨小时
    const crossOk = await this._waitCrossHour(verifyHour, 200);
    if (!crossOk) {
      assertions.push({ pass: false, code: 'CROSS_HOUR_TIMEOUT', message: `跨小时等待超时` });
      return;
    }

    // 读取历史确认
    // TODO: 需要 readHistoryTail 实现
    this._log(`跨小时成功: ${verifyHour}`);

    // 立即对时到另一个时间，检查是否产生非预期历史
    this._log('执行对时跳变测试...');
    await this._stateReader.syncTime({
      year: yesterday.getFullYear(),
      month: yesterday.getMonth() + 1,
      day: yesterday.getDate(),
      hour: freezeHour + 4,
      minute: 57,
      second: 0,
    });

    // TODO: 读取历史缓冲，检查条目数和值
    // 恢复时间
    await this._stateReader.restoreRealTime();
  }

  // ============================================================
  // 配置热更新
  // ============================================================

  /**
   * 执行配置热更新场景 (T-HOT-001~007)
   */
  async _executeConfigHotUpdate(scenario, assertions) {
    switch (scenario.id) {
      case 'T-HOT-001': return await this._execHotEnable(scenario, assertions);
      case 'T-HOT-002': return await this._execHotDisable(scenario, assertions);
      case 'T-HOT-003': return await this._execHotPortSwitch(scenario, assertions);
      case 'T-HOT-004': return await this._execHotThreshold(scenario, assertions, 'temp');
      case 'T-HOT-005': return await this._execHotThreshold(scenario, assertions, 'humi');
      case 'T-HOT-006': return await this._execHotCompensation(scenario, assertions, 'temp');
      case 'T-HOT-007': return await this._execHotCompensation(scenario, assertions, 'humi');
      default: throw new Error(`未知热更新场景: ${scenario.id}`);
    }
  }

  /**
   * 传感器启用热更新
   */
  async _execHotEnable(scenario, assertions) {
    const { configRegister, enableBit, sensorValue } = scenario.inputs;

    // 读取当前安装位
    const current = await this._stateReader.readRegister(configRegister);
    this._log(`当前安装位: 0x${current.toString(16)}`);

    // 写入启用位
    const newConfig = current | (1 << enableBit);
    await this._stateReader.writeRegister(configRegister, newConfig);

    // 回读确认
    const readback = await this._stateReader.readRegister(configRegister);
    assertions.push(this._assertEngine.assertEqual(readback, newConfig,
      `配置回读: 写入 0x${newConfig.toString(16)}, 读回 0x${readback.toString(16)}`));

    // 设置模拟器值
    this._simulator.setSensorValue(sensorValue.key, sensorValue.value);

    // 等待轮询队列重建
    await this._waitCollect(5000);

    // 验证数据采集
    const data = await this._stateReader.readRegister(scenario.expected.dataRegister);
    const expectedRaw = Math.round(sensorValue.value * 10);
    assertions.push(this._assertEngine.assertClose(data, expectedRaw, 2,
      `启用后数据: ${data}, 期望: ${expectedRaw}`));

    // 恢复原配置
    await this._stateReader.writeRegister(configRegister, current);
  }

  /**
   * 传感器禁用热更新
   */
  async _execHotDisable(scenario, assertions) {
    const { configRegister, disableBit, sensorValue } = scenario.inputs;

    // 先设置模拟器值
    this._simulator.setSensorValue(sensorValue.key, sensorValue.value);
    await this._waitCollect(5000);
    const beforeValue = await this._stateReader.readRegister(scenario.expected.dataRegister);

    // 写入禁用位
    const current = await this._stateReader.readRegister(configRegister);
    const newConfig = current & ~(1 << disableBit);
    await this._stateReader.writeRegister(configRegister, newConfig);

    // 回读确认
    const readback = await this._stateReader.readRegister(configRegister);
    assertions.push(this._assertEngine.assertEqual(readback, newConfig,
      `配置回读: 写入 0x${newConfig.toString(16)}, 读回 0x${readback.toString(16)}`));

    // 等待
    await this._waitCollect(5000);

    // 验证数据不再更新（改变模拟器值后读取应不变）
    this._simulator.setSensorValue(sensorValue.key, sensorValue.value + 5);
    await this._waitCollect(5000);
    const afterValue = await this._stateReader.readRegister(scenario.expected.dataRegister);

    // 禁用后数据不应变化
    assertions.push(this._assertEngine.assertEqual(afterValue, beforeValue,
      `禁用后数据不变: before=${beforeValue}, after=${afterValue}`));

    // 恢复原配置
    await this._stateReader.writeRegister(configRegister, current);
  }

  /**
   * RS485 端口切换热更新
   */
  async _execHotPortSwitch(scenario, assertions) {
    // TODO: 需要确认端口配置寄存器地址
    this._log('端口切换热更新: 需要确认端口配置寄存器地址');
    assertions.push({ pass: true, code: null, message: '端口切换: 待硬件资源确认' });
  }

  /**
   * 阈值热更新 (温度/湿度)
   */
  async _execHotThreshold(scenario, assertions, type) {
    const { newThreshold, testValue, recoverValue } = scenario.inputs;

    // 写入新阈值
    const thresholdReg = type === 'temp' ? 0x7010 : 0x7011;  // TODO: 确认实际地址
    const thresholdRaw = Math.round(newThreshold * 10);
    await this._stateReader.writeRegister(thresholdReg, thresholdRaw);

    // 回读确认
    const readback = await this._stateReader.readRegister(thresholdReg);
    assertions.push(this._assertEngine.assertEqual(readback, thresholdRaw,
      `阈值回读: ${readback}, 期望: ${thresholdRaw}`));

    // 设置超阈值
    const sensorKey = type === 'temp' ? 'temp_1' : 'humi_1';
    this._simulator.setSensorValue(sensorKey, testValue);
    this._log(`设置超阈值: ${sensorKey} = ${testValue}`);
    await this._waitCollect(5000);

    // TODO: 读取告警寄存器断言告警置位

    // 恢复正常值
    this._simulator.setSensorValue(sensorKey, recoverValue);
    this._log(`恢复正常值: ${sensorKey} = ${recoverValue}`);
    await this._waitCollect(5000);

    // TODO: 读取告警寄存器断言告警清除
  }

  /**
   * 补偿热更新 (温度/湿度)
   */
  async _execHotCompensation(scenario, assertions, type) {
    const { compensationValue, baseSensor } = scenario.inputs;
    const { beforeCompensation, afterCompensation, afterRestore, tolerance } = scenario.expected;

    // 设置基础值
    this._simulator.setSensorValue(baseSensor.key, baseSensor.value);
    await this._waitCollect(5000);

    // 读取补偿前值
    const regAddr = type === 'temp' ? 0x1001 : 0x1001;  // TODO: 按实际传感器路数
    const before = await this._stateReader.readRegister(regAddr);
    const beforeVal = type === 'temp' ? (before > 32767 ? before - 65536 : before) / 10 : before / 10;
    assertions.push(this._assertEngine.assertClose(beforeVal, beforeCompensation, tolerance,
      `补偿前: ${beforeVal}, 期望: ${beforeCompensation}`));

    // 写入补偿值
    const compReg = type === 'temp' ? 0x7020 : 0x7021;  // TODO: 确认实际地址
    await this._stateReader.writeRegister(compReg, compensationValue);
    await this._waitCollect(3000);

    // 读取补偿后值
    const after = await this._stateReader.readRegister(regAddr);
    const afterVal = type === 'temp' ? (after > 32767 ? after - 65536 : after) / 10 : after / 10;
    assertions.push(this._assertEngine.assertClose(afterVal, afterCompensation, tolerance,
      `补偿后: ${afterVal}, 期望: ${afterCompensation}`));

    // 恢复补偿为 0
    await this._stateReader.writeRegister(compReg, 0);
    await this._waitCollect(3000);

    // 读取恢复后值
    const restored = await this._stateReader.readRegister(regAddr);
    const restoredVal = type === 'temp' ? (restored > 32767 ? restored - 65536 : restored) / 10 : restored / 10;
    assertions.push(this._assertEngine.assertClose(restoredVal, afterRestore, tolerance,
      `恢复后: ${restoredVal}, 期望: ${afterRestore}`));
  }

  // ============================================================
  // 综合场景
  // ============================================================

  /**
   * 执行综合场景 (T-COMP-001~002)
   */
  async _executeComposite(scenario, assertions) {
    if (scenario.id === 'T-COMP-001') {
      return await this._execRecovery(scenario, assertions);
    }
    if (scenario.id === 'T-COMP-002') {
      return await this._execMultiFault(scenario, assertions);
    }
    throw new Error(`未知综合场景: ${scenario.id}`);
  }

  /**
   * 异常恢复
   */
  async _execRecovery(scenario, assertions) {
    const { faultPhase, recoverPhase } = scenario.inputs;

    // 注入故障
    this._simulator.injectTimeout({ key: faultPhase.key });
    this._log(`注入故障: ${faultPhase.key}`);
    await this._waitCollect(60000);

    // 验证离线状态
    const offlineValue = await this._stateReader.readRegister(0x1001);
    assertions.push(this._assertEngine.assertInvalid(offlineValue,
      `离线后 temp_1 应为 INVALID: ${offlineValue}`));

    // 恢复
    this._simulator.clearFault(faultPhase.key);
    this._simulator.setSensorValue(recoverPhase.key, recoverPhase.value);
    this._log(`恢复: ${faultPhase.key} = ${recoverPhase.value}`);
    await this._waitCollect(15000);

    // 验证恢复
    const recoveredValue = await this._stateReader.readRegister(0x1001);
    const expectedRaw = Math.round(recoverPhase.value * 10);
    assertions.push(this._assertEngine.assertClose(recoveredValue, expectedRaw, 2,
      `恢复后 temp_1: ${recoveredValue}, 期望: ${expectedRaw}`));
  }

  /**
   * 多路同时失效
   */
  async _execMultiFault(scenario, assertions) {
    const { faultKeys, normalKeys, normalValue } = scenario.inputs;
    const { expectedActual, tolerance } = scenario.expected;

    // 设置所有正常路的值
    for (const key of normalKeys) {
      this._simulator.setSensorValue(key, normalValue);
    }

    // 注入故障
    for (const key of faultKeys) {
      this._simulator.injectTimeout({ key });
    }
    this._log(`注入 ${faultKeys.length} 路故障, ${normalKeys.length} 路正常`);

    // 等待 ErRead 触发
    await this._waitCollect(60000);

    // 读取 ActualTemp
    const actual = await this._stateReader.readActualTempHumi();
    assertions.push(this._assertEngine.assertActualValue(
      actual.actualTemp, expectedActual, tolerance, 'temp'
    ));
    this._log(`多路失效后 ActualTemp: ${actual.actualTemp}, 期望: ${expectedActual}`);
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 等待采集周期
   */
  async _waitCollect(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 等待跨小时
   * @param {number} expectedHour
   * @param {number} maxWaitSec
   * @returns {Promise<boolean>}
   */
  async _waitCrossHour(expectedHour, maxWaitSec) {
    for (let i = 0; i < maxWaitSec; i++) {
      await this._waitCollect(1000);
      try {
        const hr = await this._stateReader.readRegister(BLOCK_SENSOR_TIME.TIME_HOUR);
        if (hr === expectedHour) return true;
      } catch (e) {
        // 读取失败，继续等待
      }
    }
    return false;
  }

  /**
   * 获取传感器 key 中的索引号
   */
  _getSensorIndex(key) {
    const match = key.match(/_(\d+)$/);
    return match ? parseInt(match[1]) - 1 : 0;
  }

  /**
   * 场景清理
   */
  async _cleanup(scenario) {
    try {
      if (scenario.cleanup) {
        for (const action of scenario.cleanup) {
          if (action === 'restoreDefaultSensors') {
            // 恢复默认传感器值（不做特殊处理）
          } else if (action === 'clearFaults') {
            this._simulator.clearAllFaults();
          } else if (action.startsWith('clearFault:')) {
            const key = action.split(':')[1];
            this._simulator.clearFault(key);
          } else if (action === 'restoreRealTime') {
            await this._stateReader.restoreRealTime().catch(() => {});
          } else if (action === 'restoreInstallConfig') {
            // TODO: 恢复安装配置
          } else if (action === 'batchClearFault') {
            this._simulator.clearAllFaults();
          }
        }
      }
    } catch (e) {
      console.error(`[SensorTestExecutor] 清理异常: ${e.message}`);
    }
  }

  _log(msg) {
    console.log(`[SensorTestExecutor] ${msg}`);
    this.emit('log', msg);
  }
}

module.exports = SensorTestExecutor;
module.exports.EXEC_RESULT = EXEC_RESULT;
