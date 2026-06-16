/**
 * backend/ate/TestManager.js
 * ATE 测试会话管理器
 *
 * 职责：
 *   1. 管理测试会话生命周期（创建、执行、停止、复位）
 *   2. 协调 AteTcpClient 与设备通信
 *   3. 解析测试进度和结果
 *   4. 生成测试报告
 *   5. 确保同一设备同时只能有一个测试会话
 *
 * 开发依据：
 *   - P0 方案第 5 章：后端 TestManager、事务锁、WebSocket
 *   - P0 方案第 14 章：测试执行细则
 *   - shared/constants.js：TEST_CMD, TEST_STATUS, SINGLE_RESULT
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，支持会话管理、测试执行、安全释放
 */

'use strict';

const EventEmitter = require('events');
const TestCatalog = require('./TestCatalog');
const TestReportService = require('./TestReportService');
const AteTcpClient = require('./AteTcpClient');
const TestScenarioCatalog = require('./TestScenarioCatalog');
const ControllerStateReader = require('./ControllerStateReader');
const AssertEngine = require('./AssertEngine');
const {
  TEST_CMD,
  TEST_STATUS,
  TEST_STATUS_TEXT,
  SINGLE_RESULT,
  SINGLE_RESULT_TEXT,
  BLOCK_TEST_STATUS,
  ATE_TEST_BLOCK_SIZE,
  ATE_MASK_ALL,
  ERROR_CODE,
  ERROR_CODE_DETAIL,
  CONFIG_DEFAULTS,
} = require('../../shared/constants');

/**
 * 测试会话状态
 */
const SESSION_STATE = {
  IDLE: 'idle',
  ENTERING: 'entering',       // 正在进入测试模式
  CONFIGURING: 'configuring', // 正在配置测试参数
  RUNNING: 'running',         // 测试执行中
  STOPPING: 'stopping',       // 正在停止
  RESETTING: 'resetting',     // 正在复位
  FINISHED: 'finished',       // 测试完成
  ERROR: 'error',             // 测试错误
};

/**
 * 测试会话
 */
class TestSession {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `ATE-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    this.deviceKey = options.deviceKey;
    this.deviceIp = options.deviceIp;
    this.operatorInputId = options.operatorInputId || '';
    this.deviceModel = options.deviceModel || '9200';
    this.workOrder = options.workOrder || '';
    this.selectedItemIds = options.selectedItemIds || [];
    this.deviceSn = options.deviceSn || '';
    this.firmwareVersion = options.firmwareVersion || '';
    this.state = SESSION_STATE.IDLE;
    this.startTime = null;
    this.endTime = null;

    /**
     * 测试项 timeline：Map<itemId, { state, startTime, endTime, errorCode, diagnostics }>
     */
    this.timeline = new Map();

    /**
     * 测试摘要
     */
    this.summary = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
    };

    /**
     * 当前正在测试的项 ID
     */
    this.currentItemId = null;

    /**
     * 测试进度百分比
     */
    this.progress = 0;

    /**
     * 测试结果状态码
     */
    this.overallStatus = TEST_STATUS.IDLE;

    /**
     * 错误信息
     */
    this.error = null;

    /**
     * 原始寄存器快照
     */
    this.registersSnapshot = {};
  }
}

/**
 * ATE 测试管理器
 * 管理测试会话生命周期，协调设备通信和测试执行
 */
class TestManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {DevicePool} options.devicePool - 设备连接池
   * @param {PollingEngine} options.pollingEngine - 轮询引擎
   * @param {WebSocketMgr} options.wsManager - WebSocket 管理器
   */
  constructor(options = {}) {
    super();

    this._devicePool = options.devicePool;
    this._pollingEngine = options.pollingEngine;
    this._wsManager = options.wsManager;

    /**
     * 测试目录
     */
    this._catalog = new TestCatalog();

    /**
     * 报告服务
     */
    this._reportService = new TestReportService();

    /**
     * P1 传感器测试场景目录
     */
    this._scenarioCatalog = new TestScenarioCatalog();

    /**
     * 断言引擎
     */
    this._assertEngine = new AssertEngine();

    /**
     * 传感器模拟器实例（外部注入）
     */
    this._sensorSimulator = options.sensorSimulator || null;

    /**
     * 环控器状态读取器：Map<deviceKey, ControllerStateReader>
     */
    this._stateReaders = new Map();

    /**
     * 活跃会话：Map<deviceKey, TestSession>
     * 确保同一设备同时只能有一个测试会话
     */
    this._activeSessions = new Map();

    /**
     * 轮询定时器：Map<deviceKey, timerId>
     */
    this._pollingTimers = new Map();

    /**
     * ATE TCP 客户端池：Map<deviceKey, AteTcpClient>
     */
    this._tcpClients = new Map();

    /**
     * 统计信息
     */
    this._stats = {
      totalSessions: 0,
      completedSessions: 0,
      failedSessions: 0,
    };
  }

  // ============================================================
  // 公共方法
  // ============================================================

  /**
   * 获取测试目录
   * @returns {TestCatalog}
   */
  getCatalog() {
    return this._catalog;
  }

  /**
   * 获取设备的活跃会话
   * @param {string} deviceKey
   * @returns {TestSession|null}
   */
  getSession(deviceKey) {
    return this._activeSessions.get(deviceKey) || null;
  }

  /**
   * 检查设备是否正在测试
   * @param {string} deviceKey
   * @returns {boolean}
   */
  isDeviceUnderTest(deviceKey) {
    return this._activeSessions.has(deviceKey);
  }

  /**
   * 获取所有活跃会话
   * @returns {TestSession[]}
   */
  getActiveSessions() {
    return Array.from(this._activeSessions.values());
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * 获取或创建 ControllerStateReader
   * @param {string} deviceKey
   * @returns {ControllerStateReader}
   */
  getStateReader(deviceKey) {
    if (!this._stateReaders.has(deviceKey)) {
      this._stateReaders.set(deviceKey, new ControllerStateReader({
        devicePool: this._devicePool,
        deviceKey,
      }));
    }
    return this._stateReaders.get(deviceKey);
  }

  /**
   * 设置传感器模拟器
   * @param {SensorSimulator} simulator
   */
  setSensorSimulator(simulator) {
    this._sensorSimulator = simulator;
  }

  /**
   * 获取场景目录
   * @returns {TestScenarioCatalog}
   */
  getScenarioCatalog() {
    return this._scenarioCatalog;
  }

  // ============================================================
  // 传感器测试执行（P1）
  // ============================================================

  /**
   * 运行单个传感器测试场景
   * @param {object} options
   * @param {string} options.scenarioId - 场景 ID（如 'T-READ-001'）
   * @param {string} options.deviceKey - 设备键
   * @param {string} [options.fieldType='A'] - 场区类型
   * @returns {Promise<{pass: boolean, results: object[], report: object}>}
   */
  async runSensorScenario(options) {
    const { scenarioId, deviceKey, fieldType = 'A' } = options;

    if (!this._sensorSimulator) {
      throw new Error('传感器模拟器未设置，请先调用 setSensorSimulator()');
    }

    const scenario = this._scenarioCatalog.loadScenario(scenarioId);
    if (!scenario) {
      throw new Error(`场景未找到: ${scenarioId}`);
    }

    const stateReader = this.getStateReader(deviceKey);
    const startTime = Date.now();
    const allResults = [];
    const transactionLog = [];

    console.log(`[TestManager] 开始传感器测试: ${scenarioId} (${scenario.name})`);
    this.emit('sensor_test_started', { scenarioId, deviceKey });

    try {
      // 1. 加载场区配置
      this._sensorSimulator.loadFieldConfig(fieldType);

      // 2. 设置模拟器输入
      if (scenario.inputs && scenario.inputs.sensors) {
        for (const sensor of scenario.inputs.sensors) {
          this._sensorSimulator.setSensorValue(sensor.key, sensor.value);
        }
      }

      // 3. 等待环控器采集周期
      const waitMs = scenario.inputs && scenario.inputs.waitMs || 15000;
      console.log(`[TestManager] 等待采集周期: ${waitMs}ms`);
      await this._sleep(waitMs);

      // 4. 读取环控器结果
      let actualData;
      if (scenarioId.startsWith('T-READ-001') || scenarioId.startsWith('T-READ-002')) {
        actualData = await stateReader.readSensorData();
      } else if (scenarioId.startsWith('T-READ-003')) {
        actualData = await stateReader.readSensorData();
      } else if (scenarioId.startsWith('T-READ-004')) {
        actualData = await stateReader.readSensorData();
      }

      const actualActual = await stateReader.readActualTempHumi();

      // 5. 执行断言
      const tolerance = scenario.expected ? scenario.expected.tolerance || 0.2 : 0.2;

      if (scenario.inputs && scenario.inputs.sensors) {
        for (const sensor of scenario.inputs.sensors) {
          let actualValue;
          if (sensor.key.startsWith('temp_')) {
            const idx = parseInt(sensor.key.split('_')[1]) - 1;
            actualValue = actualData ? actualData.temp[idx] : null;
          } else if (sensor.key.startsWith('humi_')) {
            const idx = parseInt(sensor.key.split('_')[1]) - 1;
            actualValue = actualData ? actualData.humi[idx] : null;
          } else if (sensor.key.startsWith('co2_')) {
            const idx = parseInt(sensor.key.split('_')[1]) - 1;
            actualValue = actualData ? actualData.co2[idx] : null;
          } else if (sensor.key.startsWith('press_')) {
            const idx = parseInt(sensor.key.split('_')[1]) - 1;
            actualValue = actualData ? actualData.press[idx] : null;
          }

          if (actualValue != null) {
            const result = this._assertEngine.assertSensorValue(
              actualValue, sensor.value, tolerance, sensor.key
            );
            allResults.push(result);
          }
        }
      }

      // 6. 平均值断言
      if (scenarioId === 'T-READ-001' && actualData && actualActual) {
        const validTemps = actualData.temp.filter((_, i) => true);  // TODO: 过滤未安装
        const expectedAvg = validTemps.reduce((a, b) => a + b, 0) / validTemps.length;
        const avgResult = this._assertEngine.assertActualValue(
          actualActual.actualTemp, expectedAvg, tolerance, 'temp'
        );
        allResults.push(avgResult);
      }

      if (scenarioId === 'T-READ-002' && actualData && actualActual) {
        const validHumis = actualData.humi.filter((_, i) => true);
        const expectedAvg = validHumis.reduce((a, b) => a + b, 0) / validHumis.length;
        const avgResult = this._assertEngine.assertActualValue(
          actualActual.actualHumi, expectedAvg, tolerance, 'humi'
        );
        allResults.push(avgResult);
      }

      // 7. 检查结果
      const { allPassed, failures } = this._assertEngine.checkResults(allResults);

      // 8. 记录交易日志
      transactionLog.push(...this._sensorSimulator.getTransactionLog());

      const elapsed = Date.now() - startTime;
      console.log(`[TestManager] 传感器测试完成: ${scenarioId}, 耗时 ${elapsed}ms, ${allPassed ? 'PASS' : 'FAIL'}`);

      this.emit('sensor_test_finished', {
        scenarioId,
        deviceKey,
        pass: allPassed,
        elapsed,
        total: allResults.length,
        failures: failures.length,
      });

      return {
        pass: allPassed,
        results: this._assertEngine.toReportFormat(allResults),
        report: {
          scenarioId,
          scenarioName: scenario.name,
          deviceKey,
          fieldType,
          startTime,
          endTime: Date.now(),
          duration: elapsed,
          conclusion: allPassed ? '通过' : '失败',
          assertions: this._assertEngine.toReportFormat(allResults),
          transactionLog,
          simulatorState: {
            shadowRegisters: this._sensorSimulator.getShadowRegisters(),
            faultStatus: this._sensorSimulator.getFaultStatus(),
          },
        },
      };

    } catch (err) {
      console.error(`[TestManager] 传感器测试异常: ${scenarioId} - ${err.message}`);
      this.emit('sensor_test_error', { scenarioId, deviceKey, error: err.message });
      throw err;
    } finally {
      // 清理：清除模拟器故障
      try {
        if (this._sensorSimulator) {
          this._sensorSimulator.clearAllFaults();
        }
      } catch (e) {
        // 忽略清理错误
      }
    }
  }

  /**
   * 批量运行传感器测试场景
   * @param {object} options
   * @param {string[]} options.scenarioIds - 场景 ID 列表
   * @param {string} options.deviceKey
   * @param {string} [options.fieldType='A']
   * @returns {Promise<{total: number, passed: number, failed: number, results: object[]}>}
   */
  async runSensorBatch(options) {
    const { scenarioIds, deviceKey, fieldType = 'A' } = options;
    const results = [];
    let passed = 0;
    let failed = 0;

    for (const scenarioId of scenarioIds) {
      try {
        const result = await this.runSensorScenario({ scenarioId, deviceKey, fieldType });
        results.push(result);
        if (result.pass) passed++;
        else failed++;
      } catch (err) {
        results.push({ pass: false, scenarioId, error: err.message });
        failed++;
      }
    }

    return {
      total: scenarioIds.length,
      passed,
      failed,
      results,
    };
  }

  // ============================================================
  // 会话管理
  // ============================================================

  /**
   * 启动测试会话
   * @param {object} options
   * @param {string} options.deviceKey - 设备标识
   * @param {string} options.deviceIp - 设备 IP
   * @param {string} options.operatorInputId - 操作员工号
   * @param {string} options.deviceModel - 设备型号
   * @param {string} options.workOrder - 工单号
   * @param {number[]} options.selectedItemIds - 选中的测试项 ID 列表
   * @returns {Promise<TestSession>}
   */
  async startSession(options = {}) {
    const { deviceKey, deviceIp } = options;

    // 检查是否已有活跃会话
    if (this._activeSessions.has(deviceKey)) {
      throw new Error(`设备 ${deviceKey} 已有活跃测试会话`);
    }

    // 创建新会话
    const session = new TestSession(options);
    session.startTime = Date.now();
    session.state = SESSION_STATE.ENTERING;

    this._activeSessions.set(deviceKey, session);
    this._stats.totalSessions++;

    // 通知轮询引擎
    if (this._pollingEngine) {
      this._pollingEngine.markDeviceUnderTest(deviceKey);
    }

    // 发送会话创建事件
    this._emitSessionUpdate(session, 'session_created');

    try {
      // 执行测试流程
      await this._executeTest(session);
      return session;
    } catch (err) {
      session.state = SESSION_STATE.ERROR;
      session.error = err.message;
      session.endTime = Date.now();

      this._emitSessionUpdate(session, 'session_error');
      throw err;
    }
  }

  /**
   * 停止测试会话
   * @param {string} deviceKey
   * @returns {Promise<void>}
   */
  async stopSession(deviceKey) {
    const session = this._activeSessions.get(deviceKey);
    if (!session) {
      throw new Error(`设备 ${deviceKey} 无活跃测试会话`);
    }

    session.state = SESSION_STATE.STOPPING;
    this._emitSessionUpdate(session, 'session_stopping');

    // 停止轮询定时器
    this._stopPolling(deviceKey);

    // 发送停止命令
    await this._sendStopCommand(session);

    // 执行安全释放
    await this._safeRelease(session);

    // 清理会话
    session.state = SESSION_STATE.FINISHED;
    session.overallStatus = TEST_STATUS.ABORTED;
    session.endTime = Date.now();

    this._emitSessionUpdate(session, 'session_finished');

    // 恢复轮询
    this._cleanupSession(deviceKey);
  }

  /**
   * 复位测试会话
   * @param {string} deviceKey
   * @returns {Promise<void>}
   */
  async resetSession(deviceKey) {
    const session = this._activeSessions.get(deviceKey);
    if (!session) {
      throw new Error(`设备 ${deviceKey} 无活跃测试会话`);
    }

    session.state = SESSION_STATE.RESETTING;
    this._emitSessionUpdate(session, 'session_resetting');

    // 停止轮询定时器
    this._stopPolling(deviceKey);

    // 发送复位命令
    await this._sendResetCommand(session);

    // 清理时间线
    session.timeline.clear();
    session.summary = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0 };
    session.currentItemId = null;
    session.progress = 0;
    session.overallStatus = TEST_STATUS.IDLE;
    session.error = null;

    session.state = SESSION_STATE.IDLE;
    this._emitSessionUpdate(session, 'session_reset');

    // 重新启动测试
    await this._executeTest(session);
  }

  /**
   * 重测失败项
   * @param {string} deviceKey
   * @returns {Promise<void>}
   */
  async retryFailed(deviceKey) {
    const session = this._activeSessions.get(deviceKey);
    if (!session) {
      throw new Error(`设备 ${deviceKey} 无活跃测试会话`);
    }

    // 收集失败项
    const failedItems = [];
    for (const [itemId, item] of session.timeline) {
      if (item.state === SINGLE_RESULT.FAIL || item.state === SINGLE_RESULT.TIMEOUT) {
        failedItems.push(itemId);
      }
    }

    if (failedItems.length === 0) {
      throw new Error('没有失败项需要重测');
    }

    // 重置失败项状态
    for (const itemId of failedItems) {
      session.timeline.set(itemId, {
        state: SINGLE_RESULT.PENDING,
        startTime: null,
        endTime: null,
        errorCode: null,
        diagnostics: null,
      });
    }

    // 重新执行测试
    session.state = SESSION_STATE.RUNNING;
    session.overallStatus = TEST_STATUS.RUNNING;
    this._emitSessionUpdate(session, 'session_retry');

    await this._executeTest(session);
  }

  // ============================================================
  // 内部方法：ATE TCP 客户端管理
  // ============================================================

  /**
   * 获取或创建设备的 ATE TCP 客户端
   * @param {string} deviceKey
   * @param {string} deviceIp
   * @returns {AteTcpClient}
   * @private
   */
  _getOrCreateTcpClient(deviceKey, deviceIp) {
    if (this._tcpClients.has(deviceKey)) {
      return this._tcpClients.get(deviceKey);
    }
    const client = new AteTcpClient({
      deviceIp,
      port: CONFIG_DEFAULTS.ATE_TCP_PORT,
      ackTimeout: CONFIG_DEFAULTS.ATE_ACK_TIMEOUT_MS,
    });
    this._tcpClients.set(deviceKey, client);
    return client;
  }

  /**
   * 连接设备的 ATE TCP 客户端
   * @param {string} deviceKey
   * @param {string} deviceIp
   * @private
   */
  async _connectTcp(deviceKey, deviceIp) {
    const client = this._getOrCreateTcpClient(deviceKey, deviceIp);
    if (!client.isConnected()) {
      try {
        await client.connect();
        console.log(`[TestManager] TCP connected to ${deviceIp}:${CONFIG_DEFAULTS.ATE_TCP_PORT}`);
      } catch (err) {
        console.warn(`[TestManager] TCP connect failed for ${deviceIp}: ${err.message}, will use Modbus fallback`);
      }
    }
    return client;
  }

  /**
   * 断开设备的 ATE TCP 客户端
   * @param {string} deviceKey
   * @private
   */
  _disconnectTcp(deviceKey) {
    const client = this._tcpClients.get(deviceKey);
    if (client) {
      try {
        client.disconnect();
      } catch (err) {
        console.warn(`[TestManager] TCP disconnect error: ${err.message}`);
      }
      this._tcpClients.delete(deviceKey);
    }
  }

  // ============================================================
  // 内部方法：测试执行
  // ============================================================

  /**
   * 执行测试流程
   * @param {TestSession} session
   * @private
   */
  async _executeTest(session) {
    const { deviceKey } = session;

    try {
      // 1. 进入测试模式
      session.state = SESSION_STATE.ENTERING;
      this._emitSessionUpdate(session, 'entering_test_mode');
      await this._enterTestMode(session);

      // 2. 配置测试参数
      session.state = SESSION_STATE.CONFIGURING;
      this._emitSessionUpdate(session, 'configuring');
      await this._configureTest(session);

      // 3. 启动测试
      session.state = SESSION_STATE.RUNNING;
      session.overallStatus = TEST_STATUS.RUNNING;
      this._emitSessionUpdate(session, 'test_started');

      // 计算测试掩码
      const testMask = this._catalog.filterMask(
        session.selectedItemIds.reduce((mask, id) => {
          const item = this._catalog.getItemById(id);
          return mask | (item ? item.mask : 0);
        }, 0)
      );

      // 发送启动命令
      await this._devicePool.runExclusive(deviceKey, async () => {
        // 写入测试掩码
        await this._devicePool.writeRegister(deviceKey, BLOCK_TEST_STATUS.TEST_MASK, testMask);
        // 写入启动命令
        await this._devicePool.writeRegister(deviceKey, BLOCK_TEST_STATUS.START, TEST_CMD.START);
      });

      // 4. 启动轮询监控
      this._startPolling(session);

    } catch (err) {
      session.state = SESSION_STATE.ERROR;
      session.error = err.message;
      session.endTime = Date.now();

      // 执行安全释放
      await this._safeRelease(session).catch(() => {});

      this._emitSessionUpdate(session, 'test_error');
      throw err;
    }
  }

  /**
   * 进入测试模式
   * @param {TestSession} session
   * @private
   */
  async _enterTestMode(session) {
    const { deviceKey, deviceIp } = session;

    // 优先通过 ATE TCP 发送 test.enter 命令
    const tcpClient = this._getOrCreateTcpClient(deviceKey, deviceIp);
    if (tcpClient.isConnected()) {
      try {
        await tcpClient.request('test.enter', {});
        await this._sleep(500);
        return;
      } catch (err) {
        console.warn(`[TestManager] TCP test.enter failed: ${err.message}, falling back to Modbus`);
      }
    }

    // 降级到 Modbus：写入 BLOCK_TEST_STATUS.START = 1 (start)
    await this._devicePool.runExclusive(deviceKey, async () => {
      await this._devicePool.writeRegister(deviceKey, BLOCK_TEST_STATUS.START, TEST_CMD.START);
    });

    // 等待设备响应
    await this._sleep(500);
  }

  /**
   * 配置测试参数
   * @param {TestSession} session
   * @private
   */
  async _configureTest(session) {
    const { deviceKey, deviceModel } = session;

    await this._devicePool.runExclusive(deviceKey, async () => {
      // 写入设备型号
      const modelValue = deviceModel === '9250' || deviceModel === '9300' ? 1 : 0;
      await this._devicePool.writeRegister(deviceKey, 0x8038, modelValue);

      // 写入 AO 目标电压（默认 2500mV）
      await this._devicePool.writeRegister(deviceKey, 0x8030, 2500);
      await this._devicePool.writeRegister(deviceKey, 0x8031, 2500);
      await this._devicePool.writeRegister(deviceKey, 0x8032, 2500);
      await this._devicePool.writeRegister(deviceKey, 0x8033, 2500);
    });
  }

  /**
   * 启动轮询监控
   * @param {TestSession} session
   * @private
   */
  _startPolling(session) {
    const { deviceKey } = session;

    // 每 500ms 读取一次测试状态
    const timer = setInterval(async () => {
      try {
        await this._pollTestStatus(session);
      } catch (err) {
        console.error(`[TestManager] Poll test status error: ${err.message}`);
      }
    }, CONFIG_DEFAULTS.ATE_REPORT_INTERVAL_MS);

    this._pollingTimers.set(deviceKey, timer);
  }

  /**
   * 停止轮询
   * @param {string} deviceKey
   * @private
   */
  _stopPolling(deviceKey) {
    const timer = this._pollingTimers.get(deviceKey);
    if (timer) {
      clearInterval(timer);
      this._pollingTimers.delete(deviceKey);
    }
  }

  /**
   * 轮询测试状态
   * @param {TestSession} session
   * @private
   */
  async _pollTestStatus(session) {
    const { deviceKey } = session;

    // 读取测试状态寄存器区 0x8000-0x802F（48 个寄存器）
    const registers = await this._devicePool.runExclusive(deviceKey, async () => {
      const response = await this._devicePool.readHoldingRegisters(deviceKey, 0x8000, ATE_TEST_BLOCK_SIZE);
      return response.data;
    });

    // 解析状态
    const controlCmd = registers[0];                   // 0x8000
    const ventilationLevel = registers[1];             // 0x8001
    const currentItemId = registers[2];                // 0x8002
    const progress = registers[3];                     // 0x8003
    const overallStatus = registers[4];                // 0x8004
    const testMask = registers[8];                     // 0x8008

    // 更新会话状态
    session.progress = progress;
    session.overallStatus = overallStatus;

    // 更新当前测试项
    if (currentItemId !== session.currentItemId) {
      // 标记前一项完成
      if (session.currentItemId !== null && session.currentItemId !== 0) {
        this._completeItem(session, session.currentItemId, registers);
      }
      session.currentItemId = currentItemId;

      // 标记新项开始
      if (currentItemId !== 0) {
        this._startItem(session, currentItemId);
      }
    }

    // 更新单项结果（0x8010-0x8018）— 9 项
    for (let i = 0; i < 9; i++) {
      const itemId = i + 1;
      const result = registers[16 + i]; // 0x8010 offset
      if (result !== SINGLE_RESULT.PENDING && session.timeline.has(itemId)) {
        const item = session.timeline.get(itemId);
        if (item.state === SINGLE_RESULT.TESTING) {
          item.state = result;
          item.endTime = Date.now();

          if (result === SINGLE_RESULT.PASS) {
            session.summary.passed++;
          } else if (result === SINGLE_RESULT.FAIL || result === SINGLE_RESULT.TIMEOUT) {
            session.summary.failed++;
            item.errorCode = registers[32 + i]; // 0x8020 offset
          }
        }
      }
    }

    // 发送进度更新
    this._emitSessionUpdate(session, 'test_progress');

    // 检查测试是否完成
    if (overallStatus === TEST_STATUS.PASS ||
        overallStatus === TEST_STATUS.FAIL ||
        overallStatus === TEST_STATUS.ABORTED ||
        overallStatus === TEST_STATUS.TIMEOUT) {
      await this._completeSession(session, overallStatus);
    }
  }

  /**
   * 标记测试项开始
   * @param {TestSession} session
   * @param {number} itemId
   * @private
   */
  _startItem(session, itemId) {
    if (!session.timeline.has(itemId)) {
      session.timeline.set(itemId, {
        state: SINGLE_RESULT.TESTING,
        startTime: Date.now(),
        endTime: null,
        errorCode: null,
        diagnostics: null,
      });
      session.summary.total++;
      session.summary.pending--;

      this._emitSessionUpdate(session, 'item_started', { itemId });
    }
  }

  /**
   * 标记测试项完成
   * @param {TestSession} session
   * @param {number} itemId
   * @param {number[]} registers
   * @private
   */
  _completeItem(session, itemId, registers) {
    const item = session.timeline.get(itemId);
    if (item && item.state === SINGLE_RESULT.TESTING) {
      item.endTime = Date.now();
      // 状态由 _pollTestStatus 更新
    }
  }

  /**
   * 完成测试会话
   * @param {TestSession} session
   * @param {number} overallStatus
   * @private
   */
  async _completeSession(session, overallStatus) {
    const { deviceKey } = session;

    // 停止轮询
    this._stopPolling(deviceKey);

    // 更新会话状态
    session.overallStatus = overallStatus;
    session.state = SESSION_STATE.FINISHED;
    session.endTime = Date.now();

    // 计算最终摘要
    session.summary.total = session.timeline.size;
    session.summary.passed = 0;
    session.summary.failed = 0;
    session.summary.skipped = 0;

    for (const [, item] of session.timeline) {
      if (item.state === SINGLE_RESULT.PASS) session.summary.passed++;
      else if (item.state === SINGLE_RESULT.FAIL || item.state === SINGLE_RESULT.TIMEOUT) session.summary.failed++;
      else if (item.state === SINGLE_RESULT.SKIP) session.summary.skipped++;
    }

    // 生成报告
    try {
      const report = await this._reportService.generateReport(session);
      session.reportId = report.id;
      session.downloadUrl = report.downloadUrl;
    } catch (err) {
      console.error(`[TestManager] Generate report error: ${err.message}`);
    }

    // 发送完成通知
    this._emitSessionUpdate(session, 'test_finished');

    // 清理会话
    this._cleanupSession(deviceKey);

    this._stats.completedSessions++;
  }

  // ============================================================
  // 手动强制 IO
  // ============================================================

  /**
   * 手动强制 IO 输出
   * @param {object} options
   * @param {string} options.deviceKey - 设备标识
   * @param {string} options.deviceIp - 设备 IP
   * @param {object} options.outputs - 输出配置 { channel: value }
   * @param {number} options.timeoutMs - 超时释放时间（0 = 手动释放）
   * @returns {Promise<object>}
   */
  async manualForceIo(options = {}) {
    const { deviceKey, deviceIp, outputs = {}, timeoutMs = 0 } = options;

    // 优先通过 ATE TCP 发送 control.force_io
    const tcpClient = this._getOrCreateTcpClient(deviceKey, deviceIp);
    if (tcpClient.isConnected()) {
      try {
        const result = await tcpClient.request('control.force_io', { outputs, timeoutMs });
        // 设置超时释放定时器
        if (timeoutMs > 0) {
          setTimeout(async () => {
            try {
              await tcpClient.request('control.force_io', { outputs: this._buildAllOffOutputs(outputs) });
              console.log(`[TestManager] Manual force IO timeout release for ${deviceKey}`);
            } catch (err) {
              console.warn(`[TestManager] Timeout release error: ${err.message}`);
            }
          }, timeoutMs);
        }
        return result;
      } catch (err) {
        console.warn(`[TestManager] TCP force_io failed: ${err.message}, falling back to Modbus`);
      }
    }

    // 降级到 Modbus：写入继电器指令寄存器
    try {
      // 构建继电器位掩码（bit0-bit21 对应 R1-R22）
      let relayMask = 0;
      for (const [channel, value] of Object.entries(outputs)) {
        const match = channel.match(/^relay_(\d+)$/);
        if (match) {
          const relayIndex = parseInt(match[1]) - 1;
          if (relayIndex >= 0 && relayIndex < 22 && value) {
            relayMask |= (1 << relayIndex);
          }
        }
      }
      await this._devicePool.runExclusive(deviceKey, async () => {
        await this._devicePool.writeRegister(deviceKey, 0x5001, relayMask & 0xFFFF);
        await this._devicePool.writeRegister(deviceKey, 0x5002, (relayMask >> 16) & 0xFFFF);
      });

      // 设置超时释放
      if (timeoutMs > 0) {
        setTimeout(async () => {
          try {
            await this._devicePool.runExclusive(deviceKey, async () => {
              await this._devicePool.writeRegister(deviceKey, 0x5001, 0);
              await this._devicePool.writeRegister(deviceKey, 0x5002, 0);
            });
            console.log(`[TestManager] Manual force IO timeout release for ${deviceKey}`);
          } catch (err) {
            console.warn(`[TestManager] Timeout release error: ${err.message}`);
          }
        }, timeoutMs);
      }

      return { success: true, method: 'modbus' };
    } catch (err) {
      console.error(`[TestManager] Manual force IO error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * 构建全部关闭的输出配置
   * @private
   */
  _buildAllOffOutputs(outputs) {
    const off = {};
    for (const channel of Object.keys(outputs)) {
      off[channel] = 0;
    }
    return off;
  }

  // ============================================================
  // 内部方法：安全释放
  // ============================================================

  /**
   * 发送停止命令
   * @param {TestSession} session
   * @private
   */
  async _sendStopCommand(session) {
    const { deviceKey } = session;

    try {
      await this._devicePool.runExclusive(deviceKey, async () => {
        await this._devicePool.writeRegister(deviceKey, BLOCK_TEST_STATUS.START, TEST_CMD.STOP);
      });
    } catch (err) {
      console.error(`[TestManager] Send stop command error: ${err.message}`);
    }
  }

  /**
   * 发送复位命令
   * @param {TestSession} session
   * @private
   */
  async _sendResetCommand(session) {
    const { deviceKey } = session;

    try {
      await this._devicePool.runExclusive(deviceKey, async () => {
        await this._devicePool.writeRegister(deviceKey, BLOCK_TEST_STATUS.START, TEST_CMD.RESET);
      });
    } catch (err) {
      console.error(`[TestManager] Send reset command error: ${err.message}`);
    }
  }

  /**
   * 安全释放
   * 停止、断线、心跳超时都触发 test.exit
   * 确保强制 IO 不保持
   * @param {TestSession} session
   * @private
   */
  async _safeRelease(session) {
    const { deviceKey, deviceIp } = session;

    // 优先通过 ATE TCP 发送 test.exit 命令
    const tcpClient = this._tcpClients.get(deviceKey);
    if (tcpClient && tcpClient.isConnected()) {
      try {
        await tcpClient.request('test.exit', {});
        await this._sleep(500);
        return;
      } catch (err) {
        console.warn(`[TestManager] TCP test.exit failed: ${err.message}, falling back to Modbus`);
      }
    }

    // 降级到 Modbus：写入 reset 命令
    try {
      await this._devicePool.runExclusive(deviceKey, async () => {
        await this._devicePool.writeRegister(deviceKey, BLOCK_TEST_STATUS.START, TEST_CMD.RESET);
      });
      await this._sleep(500);
    } catch (err) {
      console.error(`[TestManager] Safe release error: ${err.message}`);
    }
  }

  /**
   * 清理会话
   * @param {string} deviceKey
   * @private
   */
  _cleanupSession(deviceKey) {
    this._activeSessions.delete(deviceKey);
    this._stopPolling(deviceKey);

    // 断开 TCP 连接
    this._disconnectTcp(deviceKey);

    // 通知轮询引擎恢复轮询
    if (this._pollingEngine) {
      this._pollingEngine.unmarkDeviceUnderTest(deviceKey);
    }
  }

  // ============================================================
  // 内部方法：事件发送
  // ============================================================

  /**
   * 发送会话更新事件
   * @param {TestSession} session
   * @param {string} eventType
   * @param {object} [extra]
   * @private
   */
  _emitSessionUpdate(session, eventType, extra = {}) {
    const data = {
      sessionId: session.sessionId,
      deviceKey: session.deviceKey,
      deviceIp: session.deviceIp,
      state: session.state,
      progress: session.progress,
      overallStatus: session.overallStatus,
      currentItemId: session.currentItemId,
      summary: { ...session.summary },
      timeline: this._serializeTimeline(session.timeline),
      timestamp: Date.now(),
      ...extra,
    };

    this.emit(eventType, data);

    // 通过 WebSocket 推送
    if (this._wsManager) {
      this._wsManager.broadcast({
        type: `test_${eventType}`,
        ...data,
      });
    }
  }

  /**
   * 序列化 timeline
   * @param {Map} timeline
   * @returns {object}
   * @private
   */
  _serializeTimeline(timeline) {
    const result = {};
    for (const [itemId, item] of timeline) {
      result[itemId] = { ...item };
    }
    return result;
  }

  /**
   * 工具方法：等待
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = TestManager;
module.exports.TestSession = TestSession;
module.exports.SESSION_STATE = SESSION_STATE;
