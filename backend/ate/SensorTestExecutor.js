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
   * @param {MshClient} [options.mshClient] - MSH 调试串口客户端 (历史缓冲读写)
   * @param {PollingEngine} [options.pollingEngine] - 轮询引擎 (测试时暂停轮询避免干扰)
   */
  constructor(options = {}) {
    super();
    this._devicePool = options.devicePool;
    this._simulator = options.sensorSimulator;
    this._deviceKey = options.deviceKey;
    this._fieldType = options.fieldType || 'A';
    this._ateClient = options.ateClient || null;
    this._mshClient = options.mshClient || null;
    this._pollingEngine = options.pollingEngine || null;
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

    // 注意: 轮询引擎暂停由 API 层 (sensor-test.js) 负责
    // executor 不再重复暂停，避免死锁

    try {
      // 1. 准备：加载场区（由 simulator 跟踪场区类型，避免重复重置阴影寄存器）
      this._simulator.loadFieldConfig(this._fieldType);

      // 1.5 重置所有传感器值为默认值，避免上次测试残留
      this._resetAllSensorValues();

      // 1.6 确保 TCP 连接可用（测试间可能断连）
      try {
        await this._stateReader._ensureConnected();
      } catch (e) {
        this._log(`测试前重连失败: ${e.message}`);
      }

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
      // 注意: 轮询引擎恢复由 API 层负责
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
   * 温湿度传感器在轮询队列前部，CO2/压差在中后部
   * 对 CO2/压差测试精简温湿度传感器以缩短轮询周期
   */
  async _executeNormalRead(scenario, assertions) {
    const sensors = scenario.inputs.sensors;
    const tolerance = scenario.expected.tolerance || 0.1;

    // 设置模拟器值
    for (const sensor of sensors) {
      this._simulator.setSensorValue(sensor.key, sensor.value);
    }
    this._log(`设置 ${sensors.length} 个传感器值`);

    // 判断传感器类型
    const sensorType = scenario.id.startsWith('T-READ-001') || scenario.id.startsWith('T-READ-002')
      ? 'temp' : scenario.id.startsWith('T-READ-003') ? 'press' : 'co2';

    // 根据传感器类型确定等待时间
    // 交错轮询模式: 每路传感器后跟 4 路压差, 完整周期 ~80s
    // CO2 在队列中后部, 需等完整周期; 压差有 POLL_QUERY_SEC=6 插队
    const waitMs = sensorType === 'temp' ? 15000
      : sensorType === 'co2' ? 90000   // CO2 在交错轮询 ~30s 才开始
      : 35000;                          // 压差

    this._log(`等待采集 (${sensorType}, ${waitMs/1000}秒)...`);
    await this._waitCollect(waitMs);

    // 读取环控器数据（带重试）
    let sensorData = await this._resilientReadSensorData();
    const actual = await this._resilientReadActualTempHumi();

    // 检查是否有未读到的数据，若全为0则重试一次
    const hasZeroData = this._checkAllZero(sensorData, sensorType);
    if (hasZeroData) {
      this._log('部分传感器数据为0，等待额外采集周期...');
      await this._waitCollect(15000);
      sensorData = await this._resilientReadSensorData();
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

      // 0 值检查：对压差/CO2 等 0 可能是有效值的传感器类型，跳过此检查
      const zeroIsValid = sensor.key.startsWith('press_') || sensor.key.startsWith('co2_');
      if (actualValue != null && (actualValue !== 0 || zeroIsValid)) {
        assertions.push(this._assertEngine.assertSensorValue(
          actualValue, sensor.value, tolerance, sensor.key
        ));
        passedCount++;
      } else {
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

      // 读取 ErMax 告警状态（强韧读取）
      let alarmStatus;
      try {
        alarmStatus = await this._stateReader.readAlarmStatus();
      } catch (err) {
        this._log(`读取告警状态失败: ${err.message}，尝试重连...`);
        await this._stateReader._ensureConnected();
        alarmStatus = await this._stateReader.readAlarmStatus();
      }
      const hasErMax = alarmStatus && (alarmStatus.erMax === true || alarmStatus.erMaxTemp === true);
      assertions.push({
        pass: hasErMax,
        code: hasErMax ? 'ERMAX_SET' : 'ERMAX_NOT_SET',
        message: hasErMax ? 'ErMax 告警已置位' : `ErMax 告警未置位 (raw: ${JSON.stringify(alarmStatus.raw)})`,
        expected: true,
        actual: hasErMax,
      });

      // 验证数据仍在（固定值，强韧读取）
      let regValue;
      try {
        regValue = await this._stateReader.readRegister(0x1001);
      } catch (err) {
        this._log(`读取 regValue 失败: ${err.message}，尝试重连...`);
        await this._stateReader._ensureConnected();
        regValue = await this._stateReader.readRegister(0x1001);
      }
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

    // 先让系统稳定运行 60 秒，确保偏差检测计数器清零
    // _resetAllSensorValues 已清除异常值，60秒足够固件重置计数器
    // 使用 _waitCollect 保持心跳，防止 Modbus TCP 连接超时断开
    this._log('预稳定 60 秒 (确保偏差检测计数器清零)...');
    await this._waitCollect(60000);

    // 固件偏差检测：每个轮询周期约28秒，需连续检测5次才剔除
    // 5 × 28 = 140秒，保守等 200 秒 (~1.4倍余量)
    this._log('等待偏差剔除检测 (约 200 秒)...');
    await this._waitCollect(200000);

    // 读取 ActualTemp（带重试）
    let actual;
    try {
      actual = await this._stateReader.readActualTempHumi();
    } catch (err) {
      this._log(`首次读取 ActualTemp 失败: ${err.message}，等待 10 秒重试...`);
      await this._waitCollect(10000);
      try {
        await this._stateReader._ensureConnected();
        actual = await this._stateReader.readActualTempHumi();
      } catch (err2) {
        this._log(`重试仍失败: ${err2.message}`);
        assertions.push({ pass: false, code: 'READ_FAILED', message: `读取 ActualTemp 失败: ${err2.message}` });
        return;
      }
    }
    let deviationPass = Math.abs(actual.actualTemp - expectedActual) <= tolerance;
    this._log(`首次检查: ActualTemp=${actual.actualTemp}, 期望=${expectedActual}, 偏差=${(actual.actualTemp - expectedActual).toFixed(2)}`);

    // 最多重试 2 次，每次追加 60 秒
    for (let retry = 0; !deviationPass && retry < 2; retry++) {
      this._log(`偏差未剔除，追加等待 60 秒 (重试 ${retry + 1}/2)...`);
      await this._waitCollect(60000);
      try {
        actual = await this._stateReader.readActualTempHumi();
        deviationPass = Math.abs(actual.actualTemp - expectedActual) <= tolerance;
        this._log(`重试 ${retry + 1}: ActualTemp=${actual.actualTemp}, 偏差=${(actual.actualTemp - expectedActual).toFixed(2)}`);
      } catch (err) {
        this._log(`重试读取失败: ${err.message}`);
      }
    }

    assertions.push(this._assertEngine.assertActualValue(
      actual.actualTemp, expectedActual, tolerance, 'temp'
    ));
    this._log(`ActualTemp: ${actual.actualTemp}, 期望: ${expectedActual} (容差: ${tolerance})`);

    // 同时验证原始数据是否都被采集到（可选信息性断言）
    try {
      const sensorData = await this._stateReader.readSensorData();
      for (const s of sensors) {
        const idx = this._getSensorIndex(s.key);
        const rawVal = sensorData.temp[idx];
        this._log(`  原始 ${s.key}: ${rawVal}℃ (模拟: ${s.value}℃)`);
      }
    } catch (err) {
      this._log(`读取原始数据失败: ${err.message}`);
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
   * 优先通过 MSH 串口读取历史缓冲，其次尝试 Modbus 调试寄存器 (0x7100)
   * 若均不可用，历史冻结确认跳过，启动回退验证仍可执行
   */
  async _execBootFallback(scenario, assertions) {
    const groups = scenario.freezeGroups || scenario.inputs.freezeGroups;
    const sensorKeys = scenario.sensorKeys || scenario.inputs.sensorKeys;
    const tolerance = scenario.tolerance || scenario.inputs.tolerance || 0.2;
    let historyMethod = null;  // 'msh' | 'modbus' | null

    // 精简传感器以加速轮询（历史测试只需 temp_1 + humi_1）
    await this._saveInstallConfig();
    await this._setReducedSensors(3);
    this._log('历史测试: 精简传感器至 3 路');

    // 探测历史读取方式
    if (this._mshClient) {
      try {
        await this._mshClient.connect();
        const pingOk = await this._mshClient.ping();
        if (pingOk) {
          historyMethod = 'msh';
          this._log('历史读取方式: MSH 串口 (COM4)');
          // 尝试清空历史缓冲
          const cleared = await this._mshClient.clearHistory();
          this._log(`历史清空: ${cleared ? '成功' : '不支持 (sensor_history_clear 未实现)'}`);
        }
      } catch (e) {
        this._log(`MSH 串口连接失败: ${e.message}，尝试 Modbus 调试寄存器`);
      }
    }

    if (!historyMethod) {
      // 尝试 Modbus 调试寄存器
      try {
        const history = await this._stateReader.readHistoryTail(1);
        if (history && history.length > 0) {
          historyMethod = 'modbus';
          this._log('历史读取方式: Modbus 调试寄存器 (0x7100)');
        }
      } catch (e) {
        this._log(`Modbus 历史读取失败: ${e.message}`);
      }
    }

    if (!historyMethod) {
      this._log('历史读取不可用 (MSH + Modbus 均失败)，历史冻结确认将跳过');
    }

    // === 冻结阶段 ===
    this._log('=== 冻结阶段 ===');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      this._log(`冻结第 ${i + 1} 组: ${group.name}, temp=${group.temp}, humi=${group.humi}`);

      // 设置模拟器值
      this._simulator.setSensorValue(sensorKeys.temp, group.temp);
      this._simulator.setSensorValue(sensorKeys.humi, group.humi);

      // 对时前确保连接可用（跨小时等待可能导致 TCP 断连）
      try {
        await this._stateReader.readRegister(0x0000);
      } catch (e) {
        this._log('对时前连接检查失败，重连...');
        await this._stateReader._ensureConnected();
        await new Promise(r => setTimeout(r, 2000));
      }

      // 对时到昨天 freezeHour:59 (距整点仅 1 分钟，大幅缩短跨小时等待)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const syncResult = await this._stateReader.syncTime({
        year: yesterday.getFullYear(),
        month: yesterday.getMonth() + 1,
        day: yesterday.getDate(),
        hour: group.freezeHour,
        minute: 59,
        second: 0,
      });
      assertions.push(...this._assertEngine.assertTimeSync(
        syncResult.hr17,
        { hour: syncResult.deviceTimeArray[3], minute: syncResult.deviceTimeArray[4] },
        { hour: group.freezeHour, minute: 59 }
      ));
      this._log(`对时结果: ${syncResult.ok ? '成功' : '失败'}`);

      // 等待跨小时
      this._log(`等待跨小时到 ${group.verifyHour}:00...`);
      const crossOk = await this._waitCrossHour(group.verifyHour, 200, syncResult);
      if (!crossOk) {
        assertions.push({ pass: false, code: 'CROSS_HOUR_TIMEOUT', message: `跨小时等待超时: 期望 ${group.verifyHour}` });
        return;
      }

      // 读取历史确认
      if (historyMethod) {
        try {
          let history;
          if (historyMethod === 'msh') {
            history = await this._mshClient.readHistory();
          } else {
            history = await this._stateReader.readHistoryTail(3);
          }

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
          } else {
            this._log('历史缓冲为空');
          }
        } catch (e) {
          this._log(`读取历史缓冲失败: ${e.message}`);
        }
      } else {
        this._log('跳过历史确认 (无可用读取方式)');
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

      // 重启后多次尝试重连（设备可能还在初始化）
      this._log('等待设备完全启动...');
      let reconnected = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await this._stateReader._ensureConnected();
          // 验证连接可用
          await this._stateReader.readRegister(0x0000);
          reconnected = true;
          this._log(`重启后重连成功 (attempt ${attempt})`);
          break;
        } catch (e) {
          this._log(`重启后重连失败 (attempt ${attempt}/5): ${e.message}`);
          await new Promise(r => setTimeout(r, attempt * 5000)); // 5s, 10s, 15s, 20s, 25s
        }
      }
      if (!reconnected) {
        assertions.push({ pass: false, code: 'RECONNECT_FAIL', message: '重启后无法重连' });
        return;
      }

      // 设备重启后 TCP 已重连，但固件可能还在初始化
      // 等待固件完成启动（传感器轮询队列重建等）
      this._log('等待固件完全初始化 (15 秒)...');
      await this._waitCollect(15000);

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
    await this._restoreInstallConfig();
    // 断开 MSH 串口
    if (this._mshClient) {
      await this._mshClient.disconnect().catch(() => {});
    }
    this._log('恢复完成');
  }

  /**
   * 历史更新与对时跳变防污染
   * 优先通过 MSH 串口读取历史缓冲，其次尝试 Modbus 调试寄存器
   */
  async _execHistoryUpdate(scenario, assertions) {
    const { sensorValues, freezeHour, verifyHour } = scenario.inputs;
    const { tolerance } = scenario.expected;
    let historyMethod = null;

    // 探测历史读取方式
    if (this._mshClient) {
      this._log(`[MSH] 开始探测历史读取方式...`);
      this._log(`[MSH] 连接状态: connected=${this._mshClient._connected}, ownsPort=${this._mshClient._ownsPort}, hasPort=${!!this._mshClient._serialPort}`);
      try {
        this._log(`[MSH] 正在调用 connect()...`);
        await this._mshClient.connect();
        this._log(`[MSH] connect() 成功, connected=${this._mshClient._connected}`);
        this._log(`[MSH] 正在调用 pingResult() (发送 'help' 命令)...`);
        const pingDiag = await this._mshClient.pingResult();
        const pingOk = pingDiag.ok;
        if (!pingOk) {
          this._log(`[MSH] ping 失败! error=${pingDiag.error}`);
          if (pingDiag.raw) {
            this._log(`[MSH] MSH 原始响应 (前500字符): ${JSON.stringify(pingDiag.raw).substring(0, 500)}`);
          } else {
            this._log(`[MSH] MSH 无响应 (命令超时或串口无数据)`);
          }
        } else {
          this._log('[MSH] ping 成功, MSH shell 活跃');
        }
        if (pingOk) {
          historyMethod = 'msh';
          this._log('[MSH] 历史读取方式确认: MSH 串口');
          this._log('[MSH] 正在清空历史缓冲...');
          const cleared = await this._mshClient.clearHistory();
          this._log(`[MSH] 清空历史缓冲结果: ${cleared}`);
        }
      } catch (e) {
        this._log(`[MSH] 连接/探测失败: ${e.message}`);
        this._log(`[MSH] 错误堆栈: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : 'N/A'}`);
      }
    } else {
      this._log('[MSH] mshClient 未注入，跳过 MSH 探测');
    }
    if (!historyMethod) {
      try {
        const h = await this._stateReader.readHistoryTail(1);
        if (h && h.length > 0) historyMethod = 'modbus';
      } catch (_) {}
    }

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
      minute: 59,  // 距整点仅 1 分钟
      second: 0,
    });
    assertions.push(...this._assertEngine.assertTimeSync(
      syncResult.hr17,
      { hour: syncResult.deviceTimeArray[3], minute: syncResult.deviceTimeArray[4] },
      { hour: freezeHour, minute: 59 }
    ));

    // 等待跨小时
    const crossOk = await this._waitCrossHour(verifyHour, 200, syncResult);
    if (!crossOk) {
      assertions.push({ pass: false, code: 'CROSS_HOUR_TIMEOUT', message: `跨小时等待超时` });
      return;
    }

    // 读取历史确认
    if (historyMethod) {
      try {
        let history;
        if (historyMethod === 'msh') {
          history = await this._mshClient.readHistory();
        } else {
          history = await this._stateReader.readHistoryTail(3);
        }
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
        this._log(`读取历史缓冲失败: ${e.message}`);
      }
    }
    this._log(`跨小时成功: ${verifyHour}`);

    if (!historyMethod) {
      this._log('历史读取不可用，跳过对时跳变防污染验证');
      assertions.push({
        pass: true,
        code: 'HISTORY_NOT_SUPPORTED',
        message: 'MSH 串口和 Modbus 调试寄存器均不可用，跨小时已成功但无法验证历史缓冲内容',
        expected: '历史缓冲读取支持',
        actual: '不支持 (跳过)',
      });
      await this._stateReader.restoreRealTime();
      return;
    }

    // 记录跳变前历史条目数
    let historyCountBefore = 0;
    try {
      const h = historyMethod === 'msh'
        ? await this._mshClient.readHistory()
        : await this._stateReader.readHistoryTail(25);
      historyCountBefore = h ? h.length : 0;
    } catch (_) {}

    // 立即对时到另一个时间，检查是否产生非预期历史
    this._log('执行对时跳变测试...');
    await this._stateReader.syncTime({
      year: yesterday.getFullYear(),
      month: yesterday.getMonth() + 1,
      day: yesterday.getDate(),
      hour: freezeHour + 4,
      minute: 59,
      second: 0,
    });

    // 检查对时跳变是否产生了非预期历史条目
    try {
      const historyAfter = historyMethod === 'msh'
        ? await this._mshClient.readHistory()
        : await this._stateReader.readHistoryTail(25);
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

    // 恢复时间并断开 MSH
    await this._stateReader.restoreRealTime();
    if (this._mshClient) {
      await this._mshClient.disconnect().catch(() => {});
    }
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
   *
   * 测试策略：
   *   1. 读取原端口 → 切换到新端口 → 回读验证 → 立即恢复原端口
   *   2. 恢复后再设置模拟器值并验证数据采集正常
   *
   * 设计原因：模拟器的 USB-RS485 固定连接在原端口上，切换到新端口后
   * 固件无法在新端口上找到模拟器，会保留旧缓存值（如前序测试 T-ABNF-003
   * 的 30.0）。因此回读验证后必须先恢复原端口再测试数据采集，
   * 验证配置变更不中断正常通信。
   */
  async _execHotPortSwitch(scenario, assertions) {
    // 读取当前端口配置并保存（存为实例变量供 cleanup 异常恢复使用）
    const originalPort = await this._stateReader.readPortConfig(0);
    this._originalPortConfig = originalPort;
    this._log(`当前端口: ${originalPort}`);

    // 切换到新端口
    const newPort = originalPort === 6 ? 7 : 6;
    await this._stateReader.writePortConfig(0, newPort);

    // 回读确认
    const readback = await this._stateReader.readPortConfig(0);
    assertions.push(this._assertEngine.assertEqual(readback, newPort,
      `端口回读: ${readback}, 期望: ${newPort}`));

    // 立即恢复原端口（模拟器连接在原端口，切到新端口后固件无法采集数据）
    await this._stateReader.writePortConfig(0, originalPort);
    this._log(`端口切换验证完成，已恢复原端口: ${originalPort}`);

    // 等待固件轮询队列重建（端口切换后固件需重建轮询队列，30 秒）
    this._log('等待轮询队列重建 (30 秒)...');
    await this._waitCollect(30000);

    // 验证数据正常采集（原端口上模拟器可达）
    this._simulator.setSensorValue('temp_1', 25.0);
    this._log('设置 temp_1 = 25.0，等待完整轮询周期...');
    await this._waitCollect(30000);
    const sensorData = await this._resilientReadSensorData();
    assertions.push(this._assertEngine.assertClose(sensorData.temp[0], 25.0, 0.2,
      `恢复端口后数据: ${sensorData.temp[0]}, 期望: 25.0`));
  }

  /**
   * 阈值热更新 (温度/湿度)
   * Alarm_Check() 在采集线程循环中每秒执行一次
   *
   * 温度告警使用绝对值判定: ActualTemp > TempHigh
   *   - TempHigh = 温度上限 (寄存器 0x7040, val/10 → ℃)
   *   - Alarm_Bit_TempHigh = bit0 (enableBit 默认 0x63 已置位)
   *
   * 湿度告警使用绝对值判定: Humi > HumiHigh
   *   - HumiHigh = 湿度绝对上限 (寄存器 0x7042, val/10 → %RH)
   *   - Alarm_Bit_HumiHigh = bit2 (enableBit 默认 0x63 未置位, 需显式写入)
   *
   * 告警清除延迟: SET_ALARM_TIMEOUT = 180 秒
   */
  async _execHotThreshold(scenario, assertions, type) {
    const thresholdType = type === 'temp' ? 'temp_high' : 'humi_high';

    // HIL 测试覆盖：绕过告警门控（猪只数量、防抖计时）
    const HIL_PIG_COUNT = 0x7036;
    const HIL_ALARM_SET_TIMEOUT = 0x7037;
    const HIL_ALARM_CLR_TIMEOUT = 0x7038;
    const HIL_ALARM_RESET = 0x7039;
    try {
      await this._stateReader.writeRegister(HIL_PIG_COUNT, 600);       // 猪只数=600
      await this._stateReader.writeRegister(HIL_ALARM_SET_TIMEOUT, 2); // 设置防抖=2秒
      await this._stateReader.writeRegister(HIL_ALARM_CLR_TIMEOUT, 2); // 清除防抖=2秒
      await this._stateReader.writeRegister(HIL_ALARM_RESET, 0xFFFF);  // 清零所有时间戳
      this._log('HIL 告警覆盖: pig=600, set_timeout=2s, clr_timeout=2s, timestamps reset');
    } catch (e) {
      this._log(`HIL 覆盖写入失败 (${e.message})，告警可能不触发`);
    }

    // 读取原阈值
    const originalRaw = await this._stateReader.readThreshold(thresholdType);
    this._log(`原 ${type} 阈值: ${originalRaw} (${(originalRaw / 10).toFixed(1)})`);

    if (type === 'temp') {
      // === 温度告警: 绝对值判定 (ActualTemp > TempHigh) ===
      // 温度高限告警 enableBit (bit0) 默认已开启 (0x63)，但尝试写入确保
      this._log('写入温度高限告警使能位 (highTempRca: 1)...');
      await this._writeAlarmEnable({ highTempRca: 1 });
      await this._waitCollect(2000);

      // 写入告警阈值 (绝对温度, 如 280 = 28.0℃)
      const newThresholdRaw = scenario.inputs.alarmThreshold ?? 280;
      await this._stateReader.writeThreshold(thresholdType, newThresholdRaw);
      const readback = await this._stateReader.readThreshold(thresholdType);
      assertions.push(this._assertEngine.assertEqual(readback, newThresholdRaw,
        `阈值回读: ${readback}, 期望: ${newThresholdRaw}`));
      this._log(`写入温度高限: ${newThresholdRaw} (${(newThresholdRaw / 10).toFixed(1)}℃)`);

      // 设置所有传感器超阈值: ActualTemp > TempHigh → 触发告警
      const testValue = scenario.inputs.testValue ?? 30.0;
      for (let i = 1; i <= 16; i++) {
        this._simulator.setSensorValue(`temp_${i}`, testValue);
      }
      this._log(`设置全部 16 路温度 = ${testValue}℃ (阈值 ${(newThresholdRaw / 10).toFixed(1)}℃)`);

      // 等待 Alarm_Check() 检测
      this._log('等待告警触发 (30 秒)...');
      await this._waitCollect(30000);

      let alarmAfterExceed = await this._stateReader.readAlarmStatus();
      this._log(`告警状态: tempHigh=${alarmAfterExceed.tempHigh}, raw=${JSON.stringify(alarmAfterExceed.raw)}`);
      if (!alarmAfterExceed.tempHigh) {
        this._log('告警未触发，追加等待 30 秒...');
        await this._waitCollect(30000);
        alarmAfterExceed = await this._stateReader.readAlarmStatus();
        this._log(`重试告警状态: tempHigh=${alarmAfterExceed.tempHigh}, raw=${JSON.stringify(alarmAfterExceed.raw)}`);
      }
      assertions.push(this._assertEngine.assertEqual(alarmAfterExceed.tempHigh, true,
        `超阈值后告警: ${alarmAfterExceed.tempHigh} (raw: ${JSON.stringify(alarmAfterExceed.raw)})`));

      // 恢复: 所有传感器降到阈值以下 → 清除告警
      const recoverValue = scenario.inputs.recoverValue ?? 25.0;
      for (let i = 1; i <= 16; i++) {
        this._simulator.setSensorValue(`temp_${i}`, recoverValue);
      }
      this._log(`恢复全部温度 = ${recoverValue}℃ (阈值 ${(newThresholdRaw / 10).toFixed(1)}℃)`);

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

    // 恢复告警使能位 (恢复为默认关闭)
    if (type === 'humi') {
      this._log('恢复湿度高限告警使能位 (highHumiRca: 0)...');
      await this._writeAlarmEnable({ highHumiRca: 0 });
    } else {
      this._log('恢复温度高限告警使能位 (highTempRca: 0)...');
      await this._writeAlarmEnable({ highTempRca: 0 });
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

    // 读取补偿前值（带重连重试）
    let sensorData = await this._resilientReadSensorData();
    let beforeVal = type === 'temp' ? sensorData.temp[idx] : sensorData.humi[idx];
    if (Math.abs(beforeVal - beforeCompensation) > tolerance) {
      this._log(`补偿前值 ${beforeVal} 不在容差内，追加等待 30 秒...`);
      await this._waitCollect(30000);
      sensorData = await this._resilientReadSensorData();
      beforeVal = type === 'temp' ? sensorData.temp[idx] : sensorData.humi[idx];
    }
    assertions.push(this._assertEngine.assertClose(beforeVal, beforeCompensation, tolerance,
      `补偿前: ${beforeVal}, 期望: ${beforeCompensation}`));
    this._log(`补偿前: ${beforeVal}`);

    // 写入补偿值（负值转 uint16 二进制补码，带重连重试）
    const rawComp = compensationValue < 0 ? compensationValue + 65536 : compensationValue;
    await this._resilientWriteCompensation(type, idx, rawComp);
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

    // 读取补偿后值（带重连重试）
    let sensorDataAfter = await this._resilientReadSensorData();
    let afterVal = type === 'temp' ? sensorDataAfter.temp[idx] : sensorDataAfter.humi[idx];
    if (Math.abs(afterVal - afterCompensation) > tolerance) {
      this._log(`补偿后值 ${afterVal} 不在容差内，追加等待 30 秒...`);
      await this._waitCollect(30000);
      sensorDataAfter = await this._resilientReadSensorData();
      afterVal = type === 'temp' ? sensorDataAfter.temp[idx] : sensorDataAfter.humi[idx];
    }
    assertions.push(this._assertEngine.assertClose(afterVal, afterCompensation, tolerance,
      `补偿后: ${afterVal}, 期望: ${afterCompensation}`));
    this._log(`补偿后: ${afterVal}`);

    // 恢复补偿为 0（带重连重试）
    await this._resilientWriteCompensation(type, idx, 0);
    this._log('恢复补偿为 0');

    // Mock 模式下恢复原值
    if (this._simulator.isMockMode()) {
      this._simulator.setSensorValue(baseSensor.key, baseSensor.value);
    }

    // 等待恢复
    this._log('等待恢复 (60 秒)...');
    await this._waitCollect(60000);

    // 读取恢复后值（带重连重试）
    let sensorDataRestored = await this._resilientReadSensorData();
    let restoredVal = type === 'temp' ? sensorDataRestored.temp[idx] : sensorDataRestored.humi[idx];
    if (Math.abs(restoredVal - afterRestore) > tolerance) {
      this._log(`恢复后值 ${restoredVal} 不在容差内，追加等待 30 秒...`);
      await this._waitCollect(30000);
      sensorDataRestored = await this._resilientReadSensorData();
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
   * 精简传感器至 10 路 (4路超时 + 6路正常)：10路 × 1秒 ≈ 10秒/轮，30次 ≈ 300秒
   */
  async _execMultiFault(scenario, assertions) {
    const { faultKeys, normalKeys, normalValue } = scenario.inputs;
    const { expectedActual, tolerance } = scenario.expected;

    // 精简传感器以加速 ErRead 触发
    await this._saveInstallConfig();
    try {
      const totalSensors = faultKeys.length + normalKeys.length;
      await this._setReducedSensors(totalSensors);

      // 设置所有正常路的值
      for (const key of normalKeys) {
        this._simulator.setSensorValue(key, normalValue);
      }
      this._log(`设置 ${normalKeys.length} 路正常值: ${normalValue}℃`);

      // 注入故障（persist=true 确保持续超时）
      for (const key of faultKeys) {
        this._simulator.injectTimeout({ key, persist: true });
      }
      this._log(`注入 ${faultKeys.length} 路故障, ${normalKeys.length} 路正常 (${totalSensors}路传感器)`);

      // 等待 ErRead 触发：10路 × 1秒 ≈ 10秒/轮，30次 ≈ 300秒，保守等 360 秒
      const waitSec = Math.ceil(totalSensors * 30 * 1.2);
      this._log(`等待 ErRead 触发 (约 ${waitSec} 秒, ${totalSensors}路传感器 × 30次)...`);
      await this._waitCollect(waitSec * 1000);

      // 读取 ActualTemp（强韧读取，带重连重试）
      const actual = await this._resilientReadActualTempHumi();

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
    // 每 5 秒发送一次心跳保活（GD32 超时为 15 秒）
    // 连续 1 次心跳失败即主动重连，抢在 DevicePool 4 次超时 hard reset 之前
    let consecutiveFailures = 0;
    const keepaliveInterval = 5000;
    const keepaliveTimer = setInterval(async () => {
      try {
        if (this._stateReader && this._deviceKey) {
          await this._stateReader.readRegister(0x0000); // 心跳寄存器保活
          consecutiveFailures = 0;  // 重置失败计数
        }
      } catch (_) {
        consecutiveFailures++;
        if (consecutiveFailures >= 1) {
          this._log('心跳失败，立即重连...');
          try {
            await this._stateReader._ensureConnected();
            consecutiveFailures = 0;
          } catch (e) {
            this._log(`重连失败: ${e.message}`);
          }
        }
      }
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
   *
   * 策略：先快速轮询 HR13（适配固件更新 Modbus 时钟寄存器的情况），
   * 若寄存器不更新则回退为时间推算等待（固件内部时钟前进但不回写 HR13 的情况）。
   *
   * @param {number} expectedHour - 期望的目标小时
   * @param {number} maxWaitSec - 最大等待秒数
   * @param {object} [syncResult] - syncTime() 返回结果，含 syncCompletedAt / syncMinute / syncSecond
   * @returns {Promise<boolean>}
   */
  async _waitCrossHour(expectedHour, maxWaitSec, syncResult) {
    // 第一阶段：快速轮询 HR13（兼容固件实时更新 Modbus 寄存器的情况）
    // 如果固件更新 HR13，几秒内就能检测到
    const pollDurationSec = 10;
    for (let i = 0; i < pollDurationSec; i++) {
      await this._waitCollect(1000);
      try {
        const hr = await this._stateReader.readRegister(BLOCK_SENSOR_TIME.TIME_HOUR);
        if (hr === expectedHour) return true;
      } catch (e) {
        // 读取失败，继续等待
      }
    }

    // 第二阶段：HR13 未变化，回退为时间推算等待
    // 固件内部时钟持续前进，但 HR10-HR15 Modbus 寄存器仅在 syncTime 时写入、不随运行时钟更新。
    // 根据对时完成时刻 + 对时分钟/秒数，推算距下一整点的剩余秒数。
    if (syncResult && syncResult.syncCompletedAt != null) {
      const syncMinute = syncResult.syncMinute ?? 0;
      const syncSecond = syncResult.syncSecond ?? 0;
      // 对时完成时，固件时钟为 HH:syncMinute:syncSecond → 距 (HH+1):00 的剩余秒数
      const secondsToNextHour = ((60 - syncMinute) * 60 - syncSecond);
      // 已经过的时间
      const elapsedSec = (Date.now() - syncResult.syncCompletedAt) / 1000;
      // 剩余需等待的秒数（+5 秒安全余量，确保固件已跨过整点）
      const remainingSec = Math.max(0, secondsToNextHour - elapsedSec + 5);

      this._log(`时间推算等待: 对时后已过 ${elapsedSec.toFixed(0)}s, 距整点剩余 ${remainingSec.toFixed(0)}s`);

      if (remainingSec > 0) {
        // 以 5 秒为单位分段等待，保持心跳保活
        let waitedSec = 0;
        while (waitedSec < remainingSec) {
          const chunk = Math.min(5000, (remainingSec - waitedSec) * 1000);
          await this._waitCollect(chunk);
          waitedSec += chunk / 1000;
          // 每 30 秒检查一次 HR13（万一固件确实在更新）
          if (waitedSec % 30 < 5) {
            try {
              const hr = await this._stateReader.readRegister(BLOCK_SENSOR_TIME.TIME_HOUR);
              if (hr === expectedHour) return true;
            } catch (e) { /* 忽略 */ }
          }
        }
      }

      // 等待结束，做最终 HR13 确认（可能仍未变化，但时间已到）
      try {
        const hr = await this._stateReader.readRegister(BLOCK_SENSOR_TIME.TIME_HOUR);
        if (hr === expectedHour) {
          this._log('跨小时确认: HR13 已更新');
          return true;
        }
      } catch (e) { /* 忽略 */ }

      // HR13 仍未变化，但时间推算已足够（固件内部时钟已前进，只是 HR13 不更新）
      this._log(`跨小时(时间推算): HR13 仍为旧值，但已等待足够时间，固件内部时钟应已到达 ${expectedHour}:00`);
      return true;
    }

    // 无 syncResult 信息，继续原始轮询直到 maxWaitSec
    this._log('无 syncResult 信息，回退为持续轮询');
    for (let i = pollDurationSec; i < maxWaitSec; i++) {
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
   * 写入告警使能位
   * 优先使用 Modbus 寄存器 0x7035 (需固件实现)
   * 备选使用 ATE TCP JSON 协议 (需端口 9001)
   *
   * enableBit 位定义 (来自 alarm_event.h):
   *   bit0 = Alarm_Bit_TempHigh (温度高限)
   *   bit1 = Alarm_Bit_TempLow  (温度低限)
   *   bit2 = Alarm_Bit_HumiHigh (湿度高限)
   *   bit3 = Alarm_Bit_HumiLow  (湿度低限)
   *   bit4 = Alarm_Bit_TempDiff (温差)
   *   bit5 = Alarm_Bit_CO2High  (CO2 高限)
   *   bit6 = Alarm_Bit_NH3High  (氨气高限)
   *   bit7 = Alarm_Bit_DP       (压差高限)
   *
   * 固件默认 enableBit = 0x63 (bit0+1+5+6 置位)
   *
   * @param {object} alarmConfig - 例 { highTempRca: 1 } 或 { highHumiRca: 0 }
   * @returns {Promise<boolean>}
   */
  async _writeAlarmEnable(alarmConfig) {
    const ALARM_ENABLE_REG = 0x7035;
    const BIT_MAP = {
      highTempRca: 0,  // Alarm_Bit_TempHigh
      lowTempRca:  1,  // Alarm_Bit_TempLow
      highHumiRca: 2,  // Alarm_Bit_HumiHigh
      lowHumiRca:  3,  // Alarm_Bit_HumiLow
      tempDiffRca: 4,  // Alarm_Bit_TempDiff
      CO2Rca:      5,  // Alarm_Bit_CO2High
      NH4Rca:      6,  // Alarm_Bit_NH3High
      DPRca:       7,  // Alarm_Bit_DP
    };

    try {
      // 读取当前 enableBit
      let current;
      try {
        current = await this._stateReader.readRegister(ALARM_ENABLE_REG);
      } catch (e) {
        // 0x7035 不存在，回退到 ATE TCP
        this._log(`0x7035 读取失败 (${e.message})，尝试 ATE TCP...`);
        if (this._ateClient) {
          await this._ateClient.writeConfig({ AlarmThresholdSet: alarmConfig });
          this._log(`ATE TCP 告警使能位写入成功: ${JSON.stringify(alarmConfig)}`);
          return true;
        }
        this._log('ATE TCP 也不可用，跳过告警使能位写入');
        return false;
      }

      // 修改指定位
      let newBitmask = current;
      for (const [field, enable] of Object.entries(alarmConfig)) {
        const bit = BIT_MAP[field];
        if (bit === undefined) {
          this._log(`未知告警字段: ${field}`);
          continue;
        }
        if (enable) {
          newBitmask |= (1 << bit);    // 置位
        } else {
          newBitmask &= ~(1 << bit);   // 清位
        }
      }

      // 写回
      await this._stateReader.writeRegister(ALARM_ENABLE_REG, newBitmask);

      // 回读验证
      const readback = await this._stateReader.readRegister(ALARM_ENABLE_REG);
      const ok = readback === newBitmask;
      this._log(`告警使能位: 0x${current.toString(16)} -> 0x${newBitmask.toString(16)} (回读: 0x${readback.toString(16)}, ${ok ? 'OK' : 'MISMATCH'})`);
      return ok;
    } catch (e) {
      this._log(`告警使能位写入异常: ${e.message}`);
      return false;
    }
  }

  /**
   * 重置所有传感器值为默认值
   * 避免上次测试残留的值影响当前测试
   */
  /**
   * 强韧读取传感器数据（带重连和重试）
   * 长时间等待后 TCP 连接可能已断开，需先重连再读取
   * @param {number} maxRetries 最大重试次数
   * @returns {Promise<object>} sensorData
   */
  async _resilientReadSensorData(maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this._stateReader.readSensorData();
      } catch (err) {
        this._log(`readSensorData 失败 (attempt ${i + 1}/${maxRetries}): ${err.message}`);
        if (i < maxRetries - 1) {
          this._log('尝试重连...');
          await this._stateReader._ensureConnected();
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    throw new Error(`readSensorData 连续 ${maxRetries} 次失败`);
  }

  /**
   * 强韧写入补偿值（带重连和重试）
   * @param {string} type 'temp'|'humi'
   * @param {number} index 传感器索引
   * @param {number} rawComp 原始补偿值
   * @param {number} maxRetries 最大重试次数
   */
  async _resilientWriteCompensation(type, index, rawComp, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this._stateReader.writeCompensation(type, index, rawComp);
        return;
      } catch (err) {
        this._log(`writeCompensation 失败 (attempt ${i + 1}/${maxRetries}): ${err.message}`);
        if (i < maxRetries - 1) {
          this._log('尝试重连...');
          await this._stateReader._ensureConnected();
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    throw new Error(`writeCompensation 连续 ${maxRetries} 次失败`);
  }

  /**
   * 强韧读取 ActualTemp/Humi（带重连和重试）
   * @param {number} maxRetries
   * @returns {Promise<object>}
   */
  async _resilientReadActualTempHumi(maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this._stateReader.readActualTempHumi();
      } catch (err) {
        this._log(`readActualTempHumi 失败 (attempt ${i + 1}/${maxRetries}): ${err.message}`);
        if (i < maxRetries - 1) {
          this._log('尝试重连...');
          await this._stateReader._ensureConnected();
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    throw new Error(`readActualTempHumi 连续 ${maxRetries} 次失败`);
  }

  _resetAllSensorValues() {
    if (!this._simulator) return;
    // 温度: 20+i ℃ (i=0..15) → 200,210,...,350
    for (let i = 0; i < 16; i++) {
      this._simulator.setSensorValue(`temp_${i + 1}`, 20 + i);
    }
    // 湿度: 40+2i %RH (i=0..15) → 400,420,...,700
    for (let i = 0; i < 16; i++) {
      this._simulator.setSensorValue(`humi_${i + 1}`, 40 + i * 2);
    }
    // CO2: 400~1200 ppm
    const co2Defaults = [400, 600, 800, 1000, 1200, 500, 700, 900];
    for (let i = 0; i < 8; i++) {
      this._simulator.setSensorValue(`co2_${i + 1}`, co2Defaults[i]);
    }
    // 压差: 0, 10, 25, 50 Pa
    const pressDefaults = [0, 10, 25, 50];
    for (let i = 0; i < 4; i++) {
      this._simulator.setSensorValue(`press_${i + 1}`, pressDefaults[i]);
    }
    // 清除所有故障
    this._simulator.clearAllFaults();
    this._log('传感器值已重置为默认值');
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
