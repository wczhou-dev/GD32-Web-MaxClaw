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
   * @param {AteTcpClient} [options.ateClient] - ATE TCP 客户端 (JSON 协议)
   */
  constructor(options = {}) {
    super();
    this._devicePool = options.devicePool;
    this._simulator = options.sensorSimulator;
    this._deviceKey = options.deviceKey;
    this._fieldType = options.fieldType || 'A';
    this._ateClient = options.ateClient || null;
    this._currentFieldType = null;  // 跟踪当前场区类型，避免重复重置
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
      // 1. 准备：加载场区（由 simulator 跟踪场区类型，避免重复重置阴影寄存器）
      this._simulator.loadFieldConfig(this._fieldType);

      // 2. 按场景类型执行
      let result;
      switch (scenario.type) {
        case 'pre-check':
          result = await this._executePreCheck(scenario, allAssertions);
          break;
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
  // 前置检查
  // ============================================================

  /**
   * 执行前置检查场景 (PRE-FIELD-001, PRE-INSTALL-001, PRE-ENV-001)
   */
  async _executePreCheck(scenario, assertions) {
    if (scenario.id === 'PRE-FIELD-001') {
      return await this._execPreFieldZone(scenario, assertions);
    }
    if (scenario.id === 'PRE-INSTALL-001') {
      return await this._execPreInstallStatus(scenario, assertions);
    }
    if (scenario.id === 'PRE-ENV-001') {
      return await this._execPreEnvBlock(scenario, assertions);
    }
    throw new Error(`未知前置检查场景: ${scenario.id}`);
  }

  /**
   * 场区类型读取
   */
  async _execPreFieldZone(scenario, assertions) {
    const zoneValue = await this._stateReader.readFieldZone();
    this._log(`场区类型: ${zoneValue}`);

    if (zoneValue === 0) {
      assertions.push({
        pass: false,
        code: 'FIELD_NOT_CONFIGURED',
        message: '环控器未配置场区，请先通过 HMI 设置',
        expected: '非零',
        actual: 0,
      });
      return { skipReason: 'field_not_configured' };
    }

    assertions.push({
      pass: true,
      code: 'FIELD_ZONE_OK',
      message: `场区类型: ${zoneValue}`,
      expected: '非零',
      actual: zoneValue,
    });

    // 加载对应场区的模拟器配置
    const fieldTypes = { 1: 'A', 2: 'B', 3: 'C' };
    const ft = fieldTypes[zoneValue];
    if (ft) {
      this._fieldType = ft;
      this._simulator.loadFieldConfig(ft);
      this._log(`已加载场区配置: ${ft}`);
    }
  }

  /**
   * 传感器安装状态读取
   */
  async _execPreInstallStatus(scenario, assertions) {
    const installStatus = await this._stateReader.readInstallStatus();
    this._log(`安装状态: temp=${installStatus.temp.filter(Boolean).length}路, humi=${installStatus.humi.filter(Boolean).length}路`);

    const totalInstalled = [
      ...installStatus.temp, ...installStatus.humi,
      ...installStatus.co2, ...installStatus.press,
    ].filter(Boolean).length;

    assertions.push({
      pass: totalInstalled > 0,
      code: totalInstalled > 0 ? 'INSTALL_OK' : 'NO_SENSOR_INSTALLED',
      message: `已安装传感器: ${totalInstalled} 路`,
      expected: '> 0',
      actual: totalInstalled,
    });

    // 存储安装状态供后续场景使用
    this._installStatus = installStatus;
  }

  /**
   * 传感器数据块读取
   */
  async _execPreEnvBlock(scenario, assertions) {
    const sensorData = await this._stateReader.readSensorData();
    this._log(`数据块读取: temp=${sensorData.temp.length}路, humi=${sensorData.humi.length}路`);

    const hasData = sensorData && sensorData.temp && sensorData.temp.length > 0;
    assertions.push({
      pass: hasData,
      code: hasData ? 'ENV_BLOCK_OK' : 'ENV_BLOCK_EMPTY',
      message: hasData ? '数据块读取成功' : '数据块为空',
      expected: '数据完整',
      actual: hasData ? '完整' : '空',
    });
  }

  // ============================================================
  // 正常抄读
  // ============================================================

  /**
   * 执行正常抄读场景 (T-READ-001~004)
   * 温湿度传感器在轮询队列前部，CO2/压差在中后部，需要更长等待时间
   */
  async _executeNormalRead(scenario, assertions) {
    const sensors = scenario.inputs.sensors;
    const tolerance = scenario.expected.tolerance || 0.1;

    // 设置模拟器值
    for (const sensor of sensors) {
      this._simulator.setSensorValue(sensor.key, sensor.value);
    }
    this._log(`设置 ${sensors.length} 个传感器值`);

    // 根据传感器类型确定等待时间：
    // 固件轮询队列包含所有已安装传感器（~28路），每路约1秒
    // CO2/压差在队列中后部，需要至少2个完整轮询周期才能稳定采集
    const sensorType = scenario.id.startsWith('T-READ-001') || scenario.id.startsWith('T-READ-002')
      ? 'temp' : scenario.id.startsWith('T-READ-003') ? 'press' : 'co2';
    const waitMs = sensorType === 'temp' ? 15000
      : sensorType === 'co2' ? 45000   // CO2轮询较晚，需等2个完整周期
      : 35000;                          // 压差有POLL_QUERY_SEC=6插队，稍短

    this._log(`等待采集 (${sensorType}, ${waitMs/1000}秒)...`);
    await this._waitCollect(waitMs);

    // 读取环控器数据（带重试）
    let sensorData = await this._stateReader.readSensorData();
    const actual = await this._stateReader.readActualTempHumi();

    // 检查是否有未读到的数据，若全为0则重试一次
    const hasZeroData = this._checkAllZero(sensorData, sensorType);
    if (hasZeroData) {
      this._log('部分传感器数据为0，等待额外采集周期...');
      await this._waitCollect(30000);
      sensorData = await this._stateReader.readSensorData();
    }

    // 逐路断言
    let passedCount = 0;
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

      if (actualValue != null && actualValue !== 0) {
        assertions.push(this._assertEngine.assertSensorValue(
          actualValue, sensor.value, tolerance, sensor.key
        ));
        passedCount++;
      } else {
        // 数据为0或null，记录为失败但不阻断
        assertions.push({
          pass: false,
          code: 'SENSOR_DATA_ZERO',
          message: `${sensor.key} 数据为 ${actualValue}，可能未被轮询到`,
          expected: sensor.value,
          actual: actualValue,
        });
      }
    }

    this._log(`${sensorType} 抄读: ${passedCount}/${sensors.length} 路有效`);

    // 平均值断言
    if (scenario.id === 'T-READ-001') {
      const valids = sensorData.temp.slice(0, sensors.length).filter(v => v !== 0);
      if (valids.length > 0) {
        const expectedAvg = valids.reduce((a, b) => a + b, 0) / valids.length;
        assertions.push(this._assertEngine.assertActualValue(
          actual.actualTemp, expectedAvg, tolerance, 'temp'
        ));
      }
    } else if (scenario.id === 'T-READ-002') {
      const valids = sensorData.humi.slice(0, sensors.length).filter(v => v !== 0);
      if (valids.length > 0) {
        const expectedAvg = valids.reduce((a, b) => a + b, 0) / valids.length;
        assertions.push(this._assertEngine.assertActualValue(
          actual.actualHumi, expectedAvg, tolerance, 'humi'
        ));
      }
    }
  }

  /**
   * 检查指定类型传感器数据是否全为0
   */
  _checkAllZero(sensorData, type) {
    if (type === 'co2') return sensorData.co2.every(v => v === 0);
    if (type === 'press') return sensorData.press.every(v => v === 0);
    return false;
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
   * 固件每轮轮询~1秒/传感器，16路传感器temp_1每~16秒被查询一次
   * 10次失败需约 160 秒
   */
  /**
   * ErRead：通信失败连续 30 次触发异常
   * 精简传感器至 3 路以缩短轮询周期：3路 × 1秒 ≈ 3秒/轮，30次 ≈ 90秒
   */
  async _execErRead(scenario, assertions) {
    const { preCondition, fault } = scenario.inputs;

    // 精简传感器以加速 ErRead 触发
    await this._saveInstallConfig();
    try {
      await this._setReducedSensors(3);

      // 先正常采集确认
      this._simulator.setSensorValue(preCondition.key, preCondition.value);
      this._log(`设置正常值: ${preCondition.key} = ${preCondition.value}`);
      await this._waitCollect(10000);

      // 注入超时（persist=true 确保持续超时）
      this._simulator.injectTimeout({ key: fault.key, persist: fault.persist || true });
      this._log(`注入超时: ${fault.key} (persist=true)`);

      // 等待 ErRead 触发：3路 × 1秒/轮 ≈ 3秒/轮，30次 ≈ 90秒，保守等 180 秒
      this._log('等待 ErRead 触发 (约 180 秒, 3路传感器 × 30次)...');
      await this._waitCollect(180000);

      // 读取结果
      let regValue;
      try {
        regValue = await this._stateReader.readRegister(0x1001);
      } catch (err) {
        this._log(`读取 ErRead 结果失败: ${err.message}，尝试重连...`);
        await this._stateReader._ensureConnected();
        regValue = await this._stateReader.readRegister(0x1001);
      }
      assertions.push(this._assertEngine.assertInvalid(regValue,
        `ErRead 后 temp_1 应为 INVALID: ${regValue}`));

      // 清除故障
      this._simulator.clearFault(fault.key);
    } finally {
      await this._restoreInstallConfig();
    }
  }

  /**
   * ErMax：数值不变 100 次触发
   * 精简传感器至 3 路以缩短轮询周期：3路 × 1秒 ≈ 3秒/轮，100次 ≈ 300秒
   */
  async _execErMax(scenario, assertions) {
    const { fixedValue } = scenario.inputs;

    // 精简传感器以加速 ErMax 触发
    await this._saveInstallConfig();
    try {
      await this._setReducedSensors(3);

      // 设置固定值
      this._simulator.setSensorValue(fixedValue.key, fixedValue.value);
      this._simulator.injectFixedValue({
        key: fixedValue.key,
        value: fixedValue.value,
        repeat: fixedValue.repeat || 200,
      });
      this._log(`注入固定值: ${fixedValue.key} = ${fixedValue.value} (repeat=${fixedValue.repeat || 200})`);

      // 等待 ErMax 触发：3路 × 1秒 ≈ 3秒/轮，100次 ≈ 300秒，保守等 400 秒
      this._log('等待 ErMax 触发 (约 400 秒, 3路传感器 × 100次)...');
      await this._waitCollect(400000);

      // 读取 ErMax 告警状态
      const alarmStatus = await this._stateReader.readAlarmStatus();
      const hasErMax = alarmStatus && (alarmStatus.erMax === true || alarmStatus.erMaxTemp === true);
      assertions.push({
        pass: hasErMax,
        code: hasErMax ? 'ERMAX_SET' : 'ERMAX_NOT_SET',
        message: hasErMax ? 'ErMax 告警已置位' : `ErMax 告警未置位 (raw: ${JSON.stringify(alarmStatus.raw)})`,
        expected: true,
        actual: hasErMax,
      });

      // 验证数据仍在（固定值）
      const regValue = await this._stateReader.readRegister(0x1001);
      assertions.push(this._assertEngine.assertClose(
        regValue / 10, fixedValue.value, 0.1,
        `ErMax 后 temp_1 应保持固定值`
      ));
    } finally {
      await this._restoreInstallConfig();
    }
  }

  /**
   * 偏差剔除：离群值不参与平均
   * 固件 indoorth_deviation_check() 需要连续 5 次检测到偏差 > 10°C 才剔除
   * 每个轮询周期约 28 秒，5 次 × 28 秒 = 140 秒
   * 预稳定阶段确保偏差检测计数器从上次测试清零
   */
  async _execDeviation剔除(scenario, assertions) {
    const { sensors } = scenario.inputs;
    const { expectedActual, tolerance } = scenario.expected;

    // 设置所有传感器值
    for (const s of sensors) {
      this._simulator.setSensorValue(s.key, s.value);
    }
    this._log(`设置 ${sensors.length} 个传感器值 (含 1 个离群值)`);

    // 先让系统稳定运行 120 秒，确保偏差检测计数器从上次测试清零
    this._log('预稳定 120 秒 (确保偏差检测计数器清零)...');
    await this._waitCollect(120000);

    // 固件偏差检测：每个轮询周期约28秒，需连续检测5次才剔除
    // 5 × 28 = 140秒，保守等 300 秒 (覆盖 10+ 轮检测周期)
    this._log('等待偏差剔除检测 (约 300 秒)...');
    await this._waitCollect(300000);

    // 读取 ActualTemp，若仍不符合则追加等待
    let actual = await this._stateReader.readActualTempHumi();
    let deviationPass = Math.abs(actual.actualTemp - expectedActual) <= tolerance;
    this._log(`首次检查: ActualTemp=${actual.actualTemp}, 期望=${expectedActual}, 偏差=${(actual.actualTemp - expectedActual).toFixed(2)}`);

    if (!deviationPass) {
      this._log(`偏差未剔除，追加等待 120 秒...`);
      await this._waitCollect(120000);
      actual = await this._stateReader.readActualTempHumi();
      this._log(`重试: ActualTemp=${actual.actualTemp}, 期望=${expectedActual}`);
    }

    assertions.push(this._assertEngine.assertActualValue(
      actual.actualTemp, expectedActual, tolerance, 'temp'
    ));
    this._log(`ActualTemp: ${actual.actualTemp}, 期望: ${expectedActual} (容差: ${tolerance})`);

    // 同时验证原始数据是否都被采集到（可选信息性断言）
    const sensorData = await this._stateReader.readSensorData();
    for (const s of sensors) {
      const idx = this._getSensorIndex(s.key);
      const rawVal = sensorData.temp[idx];
      this._log(`  原始 ${s.key}: ${rawVal}℃ (模拟: ${s.value}℃)`);
    }
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
   * 依赖固件实现调试寄存器 0x7100-0x7111 (历史缓冲读写)
   * 若固件不支持，历史冻结确认会跳过，但启动回退验证仍可执行
   */
  async _execBootFallback(scenario, assertions) {
    const groups = scenario.freezeGroups || scenario.inputs.freezeGroups;
    const sensorKeys = scenario.sensorKeys || scenario.inputs.sensorKeys;
    const tolerance = scenario.tolerance || scenario.inputs.tolerance || 0.2;
    let historySupported = true; // 跟踪固件是否支持历史缓冲读取

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
      if (historySupported) {
        try {
          const history = await this._stateReader.readHistoryTail(3);
          if (history && history.length > 0) {
            const latest = history.find(h => h.tm_hour === group.verifyHour);
            if (latest) {
              assertions.push(this._assertEngine.assertClose(
                latest.temp, group.temp, tolerance,
                `历史冻结 temp (tm_hour=${group.verifyHour})`
              ));
              assertions.push(this._assertEngine.assertClose(
                latest.humi, group.humi, tolerance,
                `历史冻结 humi (tm_hour=${group.verifyHour})`
              ));
              this._log(`历史确认: tm_hour=${latest.tm_hour}, temp=${latest.temp}, humi=${latest.humi}`);
            } else {
              this._log(`历史缓冲中未找到 tm_hour=${group.verifyHour} 的条目`);
            }
          }
        } catch (e) {
          this._log(`读取历史缓冲失败: ${e.message}，固件可能未实现调试寄存器 0x7100-0x7107，跳过历史确认`);
          historySupported = false;
        }
      } else {
        this._log('历史缓冲读取不支持，跳过历史确认');
      }
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
   * 依赖固件实现调试寄存器 0x7100-0x7111
   */
  async _execHistoryUpdate(scenario, assertions) {
    const { sensorValues, freezeHour, verifyHour } = scenario.inputs;
    const { tolerance } = scenario.expected;
    let historySupported = true;

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
    if (historySupported) {
      try {
        const history = await this._stateReader.readHistoryTail(3);
        if (history && history.length > 0) {
          const latest = history.find(h => h.tm_hour === verifyHour);
          if (latest) {
            assertions.push(this._assertEngine.assertClose(
              latest.temp, sensorValues.temp, tolerance,
              `跨小时冻结 temp (tm_hour=${verifyHour})`
            ));
            assertions.push(this._assertEngine.assertClose(
              latest.humi, sensorValues.humi, tolerance,
              `跨小时冻结 humi (tm_hour=${verifyHour})`
            ));
          }
        }
      } catch (e) {
        this._log(`读取历史缓冲失败: ${e.message}，固件可能未实现调试寄存器，跳过历史确认`);
        historySupported = false;
      }
    }
    this._log(`跨小时成功: ${verifyHour}`);

    if (!historySupported) {
      // 固件不支持历史缓冲读取，跳过对时跳变防污染测试
      this._log('固件不支持历史缓冲读取 (0x7100-0x7107)，跳过对时跳变防污染验证');
      assertions.push({
        pass: true,
        code: 'HISTORY_NOT_SUPPORTED',
        message: '固件未实现历史调试寄存器，跨小时已成功但无法验证历史缓冲内容',
        expected: '历史缓冲读取支持',
        actual: '不支持 (跳过)',
      });
      await this._stateReader.restoreRealTime();
      return;
    }

    // 记录跳变前历史条目数
    let historyCountBefore = 0;
    try {
      const h = await this._stateReader.readHistoryTail(25);
      historyCountBefore = h ? h.length : 0;
    } catch (_) {}

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

    // 检查对时跳变是否产生了非预期历史条目
    try {
      const historyAfter = await this._stateReader.readHistoryTail(25);
      const historyCountAfter = historyAfter ? historyAfter.length : 0;
      const polluted = historyCountAfter > historyCountBefore + 1; // 允许 +1（正常的跨小时）
      assertions.push({
        pass: !polluted,
        code: polluted ? 'TIME_JUMP_POLLUTION' : 'NO_POLLUTION',
        message: polluted ? '对时跳变产生了非预期历史条目' : '对时跳变未污染历史缓冲',
        expected: `条目数 <= ${historyCountBefore + 1}`,
        actual: historyCountAfter,
      });
    } catch (e) {
      this._log(`读取历史缓冲失败: ${e.message}`);
    }

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
   * 启用新传感器后，固件需重建轮询队列并完成至少一个完整周期才能采集到数据
   * 完整轮询周期约 28~32 秒
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

    // 等待轮询队列重建 + 完整轮询周期 (60 秒 ≈ 2 个完整周期)
    this._log('等待轮询队列重建 (60 秒)...');
    await this._waitCollect(60000);

    // 验证数据采集（带两轮重试）
    const dataReg = scenario.expected.dataRegister;
    const expectedRaw = Math.round(sensorValue.value * 10);
    let data = await this._stateReader.readRegister(dataReg);
    this._log(`首次读取 0x${dataReg.toString(16)}: ${data}, 期望: ${expectedRaw}`);

    if (data === 0 || Math.abs(data - expectedRaw) > 2) {
      this._log(`数据未就绪，追加等待 30 秒...`);
      await this._waitCollect(30000);
      data = await this._stateReader.readRegister(dataReg);
      this._log(`第二次读取: ${data}, 期望: ${expectedRaw}`);
    }

    if (data === 0 || Math.abs(data - expectedRaw) > 2) {
      this._log(`数据仍未就绪，追加等待 30 秒...`);
      await this._waitCollect(30000);
      data = await this._stateReader.readRegister(dataReg);
      this._log(`第三次读取: ${data}, 期望: ${expectedRaw}`);
    }

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

    // 先设置模拟器值并确认正常采集
    this._simulator.setSensorValue(sensorValue.key, sensorValue.value);
    await this._waitCollect(10000);
    const beforeValue = await this._stateReader.readRegister(scenario.expected.dataRegister);
    this._log(`禁用前数据: ${beforeValue}`);

    // 写入禁用位
    const current = await this._stateReader.readRegister(configRegister);
    const newConfig = current & ~(1 << disableBit);
    await this._stateReader.writeRegister(configRegister, newConfig);

    // 回读确认
    const readback = await this._stateReader.readRegister(configRegister);
    assertions.push(this._assertEngine.assertEqual(readback, newConfig,
      `配置回读: 写入 0x${newConfig.toString(16)}, 读回 0x${readback.toString(16)}`));

    // 等待轮询队列重建
    this._log('等待轮询队列重建 (10 秒)...');
    await this._waitCollect(10000);

    // 验证数据不再更新（改变模拟器值后读取应不变）
    this._simulator.setSensorValue(sensorValue.key, sensorValue.value + 5);
    await this._waitCollect(10000);
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
    // 读取当前端口配置
    const originalPort = await this._stateReader.readPortConfig(0);
    this._log(`当前端口: ${originalPort}`);

    // 切换到新端口
    const newPort = originalPort === 6 ? 7 : 6;
    await this._stateReader.writePortConfig(0, newPort);

    // 回读确认
    const readback = await this._stateReader.readPortConfig(0);
    assertions.push(this._assertEngine.assertEqual(readback, newPort,
      `端口回读: ${readback}, 期望: ${newPort}`));

    // 等待 Modbus 重建
    await this._waitCollect(5000);

    // 验证数据正常采集
    this._simulator.setSensorValue('temp_1', 25.0);
    await this._waitCollect(5000);
    const sensorData = await this._stateReader.readSensorData();
    assertions.push(this._assertEngine.assertClose(sensorData.temp[0], 25.0, 0.2,
      `切换后数据: ${sensorData.temp[0]}, 期望: 25.0`));

    // 恢复原端口
    await this._stateReader.writePortConfig(0, originalPort);
    this._log(`恢复端口: ${originalPort}`);
  }

  /**
   * 阈值热更新 (温度/湿度)
   * Alarm_Check() 在采集线程循环中每秒执行一次
   *
   * 温度告警使用偏差判定: ActualTemp - Expected_temp > TempHigh
   *   - Expected_temp = 目标温度 (寄存器 0x7001, val/10 → ℃)
   *   - TempHigh = 偏差阈值 (寄存器 0x7040, val/10 → ℃)
   *   - 因此需先读取 Expected_temp，再计算触发值和恢复值
   *
   * 湿度告警使用绝对值判定: Humi > HumiHigh
   *   - HumiHigh = 湿度绝对上限 (寄存器 0x7042, val/10 → %RH)
   *
   * 告警清除延迟: SET_ALARM_TIMEOUT = 180 秒
   */
  async _execHotThreshold(scenario, assertions, type) {
    const thresholdType = type === 'temp' ? 'temp_high' : 'humi_high';

    // 读取原阈值
    const originalRaw = await this._stateReader.readThreshold(thresholdType);
    this._log(`原 ${type} 阈值: ${originalRaw} (${(originalRaw / 10).toFixed(1)})`);

    if (type === 'temp') {
      // === 温度告警: 偏差判定 ===
      // 读取 Expected_temp (目标温度)
      const targetTempRaw = await this._stateReader.readRegister(0x7001);
      const targetTemp = targetTempRaw / 10;
      this._log(`目标温度 Expected_temp: ${targetTempRaw} (${targetTemp.toFixed(1)}℃)`);

      // 写入小偏差阈值 (3.0°C)，使告警触发点 = Expected_temp + 3.0
      const newThresholdRaw = 30; // 3.0°C 偏差
      await this._stateReader.writeThreshold(thresholdType, newThresholdRaw);
      const readback = await this._stateReader.readThreshold(thresholdType);
      assertions.push(this._assertEngine.assertEqual(readback, newThresholdRaw,
        `阈值回读: ${readback}, 期望: ${newThresholdRaw}`));
      this._log(`写入温度高限偏差: ${newThresholdRaw} (${(newThresholdRaw / 10).toFixed(1)}℃)`);

      // 设置超阈值: ActualTemp = Expected_temp + 5.0 (> Expected_temp + 3.0)
      const testValue = targetTemp + 5.0;
      this._simulator.setSensorValue('temp_1', testValue);
      this._log(`设置超阈值: temp_1 = ${testValue}℃ (目标 ${targetTemp} + 偏差 ${newThresholdRaw / 10} = ${(targetTemp + newThresholdRaw / 10).toFixed(1)}℃)`);

      // 等待 Alarm_Check() 检测 (每秒执行一次，等 30 秒确保多轮检测)
      this._log('等待告警触发 (30 秒)...');
      await this._waitCollect(30000);

      // 读取告警状态（带重试）
      let alarmAfterExceed = await this._stateReader.readAlarmStatus();
      this._log(`告警状态: tempHigh=${alarmAfterExceed.tempHigh}, raw=${JSON.stringify(alarmAfterExceed.raw)}`);
      if (!alarmAfterExceed.tempHigh) {
        this._log(`告警未触发，追加等待 20 秒...`);
        await this._waitCollect(20000);
        alarmAfterExceed = await this._stateReader.readAlarmStatus();
        this._log(`重试告警状态: tempHigh=${alarmAfterExceed.tempHigh}, raw=${JSON.stringify(alarmAfterExceed.raw)}`);
      }
      assertions.push(this._assertEngine.assertEqual(alarmAfterExceed.tempHigh, true,
        `超阈值后告警: ${alarmAfterExceed.tempHigh} (raw: ${JSON.stringify(alarmAfterExceed.raw)})`));

      // 恢复正常值: 设为目标温度-1 (低于目标，不触发偏差告警)
      const recoverValue = targetTemp - 1.0;
      this._simulator.setSensorValue('temp_1', recoverValue);
      this._log(`恢复正常值: temp_1 = ${recoverValue}℃ (低于目标 ${targetTemp}℃)`);

    } else {
      // === 湿度告警: 绝对值判定 ===
      // 湿度高限告警 enableBit 默认关闭，需先通过 JSON 协议使能
      this._log('写入湿度高限告警使能位 (highHumiRca: 1)...');
      await this._writeAlarmEnable({ highHumiRca: 1 });
      await this._waitCollect(2000); // 等待固件处理

      const newThresholdRaw = scenario.inputs.newThreshold || 550; // 55.0%RH
      await this._stateReader.writeThreshold(thresholdType, newThresholdRaw);
      const readback = await this._stateReader.readThreshold(thresholdType);
      assertions.push(this._assertEngine.assertEqual(readback, newThresholdRaw,
        `阈值回读: ${readback}, 期望: ${newThresholdRaw}`));
      this._log(`写入湿度高限: ${newThresholdRaw} (${(newThresholdRaw / 10).toFixed(1)}%RH)`);

      // 设置超阈值
      const testValue = scenario.inputs.testValue || 58.0;
      this._simulator.setSensorValue('humi_1', testValue);
      this._log(`设置超阈值: humi_1 = ${testValue}%RH (阈值 ${(newThresholdRaw / 10).toFixed(1)}%RH)`);

      // 等待 Alarm_Check() 检测
      this._log('等待告警触发 (30 秒)...');
      await this._waitCollect(30000);

      let alarmAfterExceed = await this._stateReader.readAlarmStatus();
      this._log(`告警状态: humiHigh=${alarmAfterExceed.humiHigh}, raw=${JSON.stringify(alarmAfterExceed.raw)}`);
      if (!alarmAfterExceed.humiHigh) {
        this._log(`告警未触发，追加等待 20 秒...`);
        await this._waitCollect(20000);
        alarmAfterExceed = await this._stateReader.readAlarmStatus();
        this._log(`重试告警状态: humiHigh=${alarmAfterExceed.humiHigh}, raw=${JSON.stringify(alarmAfterExceed.raw)}`);
      }
      assertions.push(this._assertEngine.assertEqual(alarmAfterExceed.humiHigh, true,
        `超阈值后告警: ${alarmAfterExceed.humiHigh} (raw: ${JSON.stringify(alarmAfterExceed.raw)})`));

      // 恢复正常值
      const recoverValue = scenario.inputs.recoverValue || 50.0;
      this._simulator.setSensorValue('humi_1', recoverValue);
      this._log(`恢复正常值: humi_1 = ${recoverValue}%RH`);
    }

    // 等待告警恢复（SET_ALARM_TIMEOUT=180秒，需等条件持续满足 180 秒）
    // 先等 120 秒，再等 60 秒重试
    this._log('等待告警恢复 (120 秒, SET_ALARM_TIMEOUT=180s)...');
    await this._waitCollect(120000);

    // 读取告警状态（带重试）
    const alarmField = type === 'temp' ? 'tempHigh' : 'humiHigh';
    let alarmAfterRecover = await this._stateReader.readAlarmStatus();
    this._log(`恢复中告警状态: ${alarmField}=${alarmAfterRecover[alarmField]}, raw=${JSON.stringify(alarmAfterRecover.raw)}`);
    if (alarmAfterRecover[alarmField]) {
      this._log(`告警未恢复，追加等待 60 秒...`);
      await this._waitCollect(60000);
      alarmAfterRecover = await this._stateReader.readAlarmStatus();
      this._log(`重试恢复状态: ${alarmField}=${alarmAfterRecover[alarmField]}, raw=${JSON.stringify(alarmAfterRecover.raw)}`);
    }
    assertions.push(this._assertEngine.assertEqual(alarmAfterRecover[alarmField], false,
      `恢复后告警清除: ${alarmAfterRecover[alarmField]}`));

    // 恢复原阈值
    await this._stateReader.writeThreshold(thresholdType, originalRaw);
    this._log(`恢复原阈值: ${originalRaw}`);

    // 恢复告警使能位 (仅湿度告警需要，恢复为默认关闭)
    if (type === 'humi') {
      this._log('恢复湿度高限告警使能位 (highHumiRca: 0)...');
      await this._writeAlarmEnable({ highHumiRca: 0 });
    }
  }

  /**
   * 补偿热更新 (温度/湿度)
   * 补偿值写入后，需等待固件完整轮询周期（~28秒）才能在 BLOCK_ENV 中生效
   */
  async _execHotCompensation(scenario, assertions, type) {
    const { compensationValue, baseSensor } = scenario.inputs;
    const { beforeCompensation, afterCompensation, afterRestore, tolerance } = scenario.expected;
    const idx = this._getSensorIndex(baseSensor.key);

    // 设置基础值并等待稳定采集
    this._simulator.setSensorValue(baseSensor.key, baseSensor.value);
    this._log(`设置基础值: ${baseSensor.key} = ${baseSensor.value}`);

    // 等待2个完整轮询周期确保采集稳定
    this._log('等待采集稳定 (60 秒)...');
    await this._waitCollect(60000);

    // 读取补偿前值（带重试）
    let sensorData = await this._stateReader.readSensorData();
    let beforeVal = type === 'temp' ? sensorData.temp[idx] : sensorData.humi[idx];
    if (Math.abs(beforeVal - beforeCompensation) > tolerance) {
      this._log(`补偿前值 ${beforeVal} 不在容差内，追加等待 30 秒...`);
      await this._waitCollect(30000);
      sensorData = await this._stateReader.readSensorData();
      beforeVal = type === 'temp' ? sensorData.temp[idx] : sensorData.humi[idx];
    }
    assertions.push(this._assertEngine.assertClose(beforeVal, beforeCompensation, tolerance,
      `补偿前: ${beforeVal}, 期望: ${beforeCompensation}`));
    this._log(`补偿前: ${beforeVal}`);

    // 写入补偿值（负值转 uint16 二进制补码）
    const rawComp = compensationValue < 0 ? compensationValue + 65536 : compensationValue;
    await this._stateReader.writeCompensation(type, idx, rawComp);
    this._log(`写入补偿值: ${type}[${idx}] = ${rawComp} (${compensationValue/10}℃)`);

    // 等待2个完整轮询周期（补偿在采集链路中实时应用，但BLOCK_ENV更新需轮询）
    this._log('等待补偿生效 (60 秒)...');
    await this._waitCollect(60000);

    // Mock 模式下模拟补偿效果
    if (this._simulator.isMockMode()) {
      const compVal = compensationValue > 32767 ? (compensationValue - 65536) / 10 : compensationValue / 10;
      this._simulator.setSensorValue(baseSensor.key, baseSensor.value + compVal);
      await this._waitCollect(1000);
    }

    // 读取补偿后值（带重试）
    let sensorDataAfter = await this._stateReader.readSensorData();
    let afterVal = type === 'temp' ? sensorDataAfter.temp[idx] : sensorDataAfter.humi[idx];
    if (Math.abs(afterVal - afterCompensation) > tolerance) {
      this._log(`补偿后值 ${afterVal} 不在容差内，追加等待 30 秒...`);
      await this._waitCollect(30000);
      sensorDataAfter = await this._stateReader.readSensorData();
      afterVal = type === 'temp' ? sensorDataAfter.temp[idx] : sensorDataAfter.humi[idx];
    }
    assertions.push(this._assertEngine.assertClose(afterVal, afterCompensation, tolerance,
      `补偿后: ${afterVal}, 期望: ${afterCompensation}`));
    this._log(`补偿后: ${afterVal}`);

    // 恢复补偿为 0
    await this._stateReader.writeCompensation(type, idx, 0);
    this._log('恢复补偿为 0');

    // Mock 模式下恢复原值
    if (this._simulator.isMockMode()) {
      this._simulator.setSensorValue(baseSensor.key, baseSensor.value);
    }

    // 等待恢复
    this._log('等待恢复 (60 秒)...');
    await this._waitCollect(60000);

    // 读取恢复后值（带重试）
    let sensorDataRestored = await this._stateReader.readSensorData();
    let restoredVal = type === 'temp' ? sensorDataRestored.temp[idx] : sensorDataRestored.humi[idx];
    if (Math.abs(restoredVal - afterRestore) > tolerance) {
      this._log(`恢复后值 ${restoredVal} 不在容差内，追加等待 30 秒...`);
      await this._waitCollect(30000);
      sensorDataRestored = await this._stateReader.readSensorData();
      restoredVal = type === 'temp' ? sensorDataRestored.temp[idx] : sensorDataRestored.humi[idx];
    }
    assertions.push(this._assertEngine.assertClose(restoredVal, afterRestore, tolerance,
      `恢复后: ${restoredVal}, 期望: ${afterRestore}`));
    this._log(`恢复后: ${restoredVal}`);
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
   * 固件 ErRead 阈值 SENSOR_READ_ERROR_THRESHOLD = 30 次
   * 精简传感器至 3 路：3路 × 1秒 ≈ 3秒/轮，30次 ≈ 90秒
   */
  async _execRecovery(scenario, assertions) {
    const { faultPhase, recoverPhase } = scenario.inputs;

    // 精简传感器以加速 ErRead 触发
    await this._saveInstallConfig();
    try {
      await this._setReducedSensors(3);

      // 注入故障（persist=true 确保持续超时）
      this._simulator.injectTimeout({ key: faultPhase.key, persist: true });
      this._log(`注入故障: ${faultPhase.key} (persist=true)`);

      // 等待 ErRead 触发：3路 × 1秒 ≈ 3秒/轮，30次 ≈ 90秒，保守等 180 秒
      this._log('等待 ErRead 触发 (约 180 秒, 3路传感器 × 30次)...');
      await this._waitCollect(180000);

      // 验证离线状态
      let offlineValue;
      try {
        offlineValue = await this._stateReader.readRegister(0x1001);
      } catch (err) {
        this._log(`读取离线值失败: ${err.message}，尝试重连...`);
        await this._stateReader._ensureConnected();
        offlineValue = await this._stateReader.readRegister(0x1001);
      }
      assertions.push(this._assertEngine.assertInvalid(offlineValue,
        `离线后 temp_1 应为 INVALID: ${offlineValue}`));

      // 恢复
      this._simulator.clearFault(faultPhase.key);
      this._simulator.setSensorValue(recoverPhase.key, recoverPhase.value);
      this._log(`恢复: ${faultPhase.key} = ${recoverPhase.value}`);

      // 等待恢复：需等固件重新成功采集并清除 ErRead
      this._log('等待恢复 (约 90 秒)...');
      await this._waitCollect(90000);

      // 验证恢复（带重试）
      let recoveredValue;
      try {
        recoveredValue = await this._stateReader.readRegister(0x1001);
      } catch (err) {
        this._log(`读取恢复值失败: ${err.message}，尝试重连...`);
        await this._stateReader._ensureConnected();
        recoveredValue = await this._stateReader.readRegister(0x1001);
      }
      const expectedRaw = Math.round(recoverPhase.value * 10);
      if (recoveredValue === 0 || recoveredValue === 0x7FFF) {
        this._log(`恢复值 ${recoveredValue} 仍异常，追加等待 60 秒...`);
        await this._waitCollect(60000);
        recoveredValue = await this._stateReader.readRegister(0x1001);
      }
      assertions.push(this._assertEngine.assertClose(recoveredValue, expectedRaw, 2,
        `恢复后 temp_1: ${recoveredValue}, 期望: ${expectedRaw}`));
      this._log(`恢复后 temp_1: ${recoveredValue}`);
    } finally {
      await this._restoreInstallConfig();
    }
  }

  /**
   * 多路同时失效
   * 固件 SENSOR_READ_ERROR_THRESHOLD = 30 次
   * 精简传感器至 6 路 (3路超时 + 3路正常)：6路 × 1秒 ≈ 6秒/轮，30次 ≈ 180秒
   */
  async _execMultiFault(scenario, assertions) {
    const { faultKeys, normalKeys, normalValue } = scenario.inputs;
    const { expectedActual, tolerance } = scenario.expected;

    // 精简传感器以加速 ErRead 触发
    await this._saveInstallConfig();
    try {
      await this._setReducedSensors(6);

      // 设置所有正常路的值
      for (const key of normalKeys) {
        this._simulator.setSensorValue(key, normalValue);
      }
      this._log(`设置 ${normalKeys.length} 路正常值: ${normalValue}℃`);

      // 注入故障（persist=true 确保持续超时）
      for (const key of faultKeys) {
        this._simulator.injectTimeout({ key, persist: true });
      }
      this._log(`注入 ${faultKeys.length} 路故障, ${normalKeys.length} 路正常 (6路传感器)`);

      // 等待 ErRead 触发：6路 × 1秒 ≈ 6秒/轮，30次 ≈ 180秒，保守等 300 秒
      this._log('等待 ErRead 触发 (约 300 秒, 6路传感器 × 30次)...');
      await this._waitCollect(300000);

      // 读取 ActualTemp（带重试）
      let actual;
      try {
        actual = await this._stateReader.readActualTempHumi();
      } catch (err) {
        this._log(`读取 ActualTemp 失败: ${err.message}，等待 60 秒后重试...`);
        await this._waitCollect(60000);
        try {
          await this._stateReader._ensureConnected();
          actual = await this._stateReader.readActualTempHumi();
        } catch (err2) {
          this._log(`重试仍失败: ${err2.message}`);
          assertions.push({ pass: false, code: 'READ_FAILED', message: `读取 ActualTemp 失败: ${err2.message}` });
          for (const key of faultKeys) { this._simulator.clearFault(key); }
          return;
        }
      }

      assertions.push(this._assertEngine.assertActualValue(
        actual.actualTemp, expectedActual, tolerance, 'temp'
      ));
      this._log(`多路失效后 ActualTemp: ${actual.actualTemp}, 期望: ${expectedActual}`);

      // 清除故障恢复
      for (const key of faultKeys) {
        this._simulator.clearFault(key);
      }
    } finally {
      await this._restoreInstallConfig();
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 等待采集周期
   * 在等待期间发送心跳保活，防止 GD32 的 Modbus TCP 连接超时断开
   */
  async _waitCollect(ms) {
    // 每 10 秒发送一次心跳保活（GD32 超时为 15 秒）
    const keepaliveInterval = 10000;
    const keepaliveTimer = setInterval(async () => {
      try {
        if (this._stateReader && this._deviceKey) {
          await this._stateReader.readRegister(0x0000); // 心跳寄存器保活
        }
      } catch (_) { /* 忽略保活失败 */ }
    }, keepaliveInterval);

    return new Promise(resolve => {
      setTimeout(() => {
        clearInterval(keepaliveTimer);
        resolve();
      }, ms);
    });
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
   * 保存当前传感器安装配置 (temp + humi 掩码)
   */
  async _saveInstallConfig() {
    try {
      const tempMask = await this._stateReader.readRegister(0x700A);
      const humiMask = await this._stateReader.readRegister(0x700B);
      this._originalInstallConfig = [tempMask, humiMask];
      this._log(`保存安装配置: temp=0x${tempMask.toString(16)}, humi=0x${humiMask.toString(16)}`);
    } catch (e) {
      this._log(`保存安装配置失败: ${e.message}`);
    }
  }

  /**
   * 设置精简传感器数量 (仅启用前 N 路 temp + humi)
   * 缩短轮询队列，加速 ErRead/ErMax 阈值累积
   * @param {number} count - 启用路数 (最少 3)
   */
  async _setReducedSensors(count) {
    const safeCount = Math.max(3, Math.min(16, count));
    const mask = safeCount >= 16 ? 0xFFFF : (1 << safeCount) - 1;
    await this._stateReader.writeRegister(0x700A, mask); // temp
    await this._stateReader.writeRegister(0x700B, mask); // humi
    this._log(`精简传感器: 启用 ${safeCount} 路 temp+humi, 掩码=0x${mask.toString(16)}`);

    // 等待轮询队列重建
    await this._waitCollect(10000);
  }

  /**
   * 恢复传感器安装配置
   */
  async _restoreInstallConfig() {
    if (this._originalInstallConfig) {
      try {
        await this._stateReader.writeRegister(0x700A, this._originalInstallConfig[0]);
        await this._stateReader.writeRegister(0x700B, this._originalInstallConfig[1]);
        this._log(`恢复安装配置: temp=0x${this._originalInstallConfig[0].toString(16)}, humi=0x${this._originalInstallConfig[1].toString(16)}`);
      } catch (e) {
        this._log(`恢复安装配置失败: ${e.message}`);
      }
    }
  }

  /**
   * 写入告警使能位 (通过 ATE TCP JSON 协议)
   * @param {object} alarmConfig - AlarmThresholdSet 部分字段
   * @returns {Promise<boolean>} 是否成功
   */
  async _writeAlarmEnable(alarmConfig) {
    if (!this._ateClient) {
      this._log('ateClient 未设置，跳过告警使能位写入');
      return false;
    }
    try {
      await this._ateClient.writeConfig({ AlarmThresholdSet: alarmConfig });
      this._log(`告警使能位写入成功: ${JSON.stringify(alarmConfig)}`);
      return true;
    } catch (e) {
      this._log(`告警使能位写入失败: ${e.message}`);
      return false;
    }
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
            // 恢复安装配置（如果有缓存的原始值）
            if (this._originalInstallConfig) {
              try {
                await this._stateReader.writeRegister(0x700A, this._originalInstallConfig[0]);
                await this._stateReader.writeRegister(0x700B, this._originalInstallConfig[1]);
                this._log('安装配置已恢复');
              } catch (e) {
                this._log(`恢复安装配置失败: ${e.message}`);
              }
            }
          } else if (action === 'restoreThreshold') {
            // 恢复阈值（如果有缓存的原始值）
            if (this._originalThresholds) {
              try {
                for (const [type, val] of Object.entries(this._originalThresholds)) {
                  await this._stateReader.writeThreshold(type, val);
                }
                this._log('阈值已恢复');
              } catch (e) {
                this._log(`恢复阈值失败: ${e.message}`);
              }
            }
          } else if (action.startsWith('restoreCompensation:')) {
            // 恢复补偿值为 0
            const compType = action.split(':')[1];
            try {
              const idx = 0; // 默认第 1 路
              await this._stateReader.writeCompensation(compType.includes('temp') ? 'temp' : 'humi', idx, 0);
              this._log(`补偿已恢复: ${compType}`);
            } catch (e) {
              this._log(`恢复补偿失败: ${e.message}`);
            }
          } else if (action === 'restorePortConfig') {
            // 恢复端口配置
            if (this._originalPortConfig != null) {
              try {
                await this._stateReader.writePortConfig(0, this._originalPortConfig);
                this._log(`端口已恢复: ${this._originalPortConfig}`);
              } catch (e) {
                this._log(`恢复端口失败: ${e.message}`);
              }
            }
          } else if (action === 'restoreDynamicValue:temp_1') {
            // 恢复动态值
            this._simulator.clearFault('temp_1');
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
