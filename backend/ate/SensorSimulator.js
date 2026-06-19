/**
 * backend/ate/SensorSimulator.js
 * 传感器模拟器 — Modbus RTU 从站
 *
 * 职责：
 *   1. 通过 USB-RS485 串口作为 Modbus RTU 从站响应环控器抄读
 *   2. 维护影子寄存器表，支持动态设置传感器值
 *   3. 支持故障注入：超时、固定值、离群值、CRC 错误
 *   4. 支持 persist 模式（故障状态跨环控器重启保持）
 *   5. 记录交易日志用于问题定位和报告
 *
 * 开发依据：
 *   - 传感器自动测试内容开发清单P1.md §9.2~9.5, §12.4
 *   - 传感器自动测试任务开发列表P1.md §六
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本
 */

'use strict';

const EventEmitter = require('events');

/**
 * 传感器状态枚举
 */
const SENSOR_STATUS = {
  NORMAL: 'normal',
  TIMEOUT: 'timeout',
  FIXED: 'fixed',
  OUTLIER: 'outlier',
  CRC_ERROR: 'crc_error',
};

/**
 * Modbus RTU CRC16 计算
 * @param {Buffer} data
 * @returns {number}
 */
function crc16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

class SensorSimulator extends EventEmitter {
  constructor(options = {}) {
    super();

    /** @type {import('serialport').SerialPort|null} */
    this._serialPort = null;
    this._portPath = options.port || 'COM3';
    this._baudRate = options.baudRate || 9600;
    this._dataBits = options.dataBits || 8;
    this._parity = options.parity || 'none';
    this._stopBits = options.stopBits || 1;

    /** Mock 模式：不打开真实串口，用于无硬件测试 */
    this._mockMode = options.mock || false;

    /** 影子寄存器表：Map<slaveAddr, Map<registerAddr, rawValue>> */
    this._shadowRegisters = new Map();

    /** 故障状态表：Map<key, { type, persist, params }> */
    this._faults = new Map();

    /** 传感器 key 到 { slaveAddr, registerAddr, scale } 的映射 */
    this._sensorKeyMap = new Map();

    /** 交易日志 */
    this._transactionLog = [];
    this._maxLogSize = options.maxLogSize || 1000;

    /** 当前场区配置 */
    this._currentFieldConfig = null;

    /** 接收缓冲区 */
    this._rxBuffer = Buffer.alloc(0);

    /** 运行状态 */
    this._running = false;

    /** 当前已加载的场区类型（避免重复加载） */
    this._loadedFieldType = null;
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 启动模拟器
   * @param {object} [options]
   * @param {string} [options.port]
   * @param {number} [options.baudRate]
   */
  async start(options = {}) {
    if (this._running) {
      console.warn('[SensorSimulator] 已在运行中');
      return;
    }

    // Mock 模式：不打开真实串口
    if (this._mockMode) {
      this._running = true;
      console.log('[SensorSimulator] 已启动 (Mock 模式)');
      this.emit('started', { mock: true });
      return;
    }

    const port = options.port || this._portPath;
    const baudRate = options.baudRate || this._baudRate;

    try {
      const { SerialPort } = require('serialport');
      this._serialPort = new SerialPort({
        path: port,
        baudRate,
        dataBits: this._dataBits,
        parity: this._parity,
        stopBits: this._stopBits,
      });

      this._serialPort.on('data', (data) => this._onData(data));
      this._serialPort.on('error', (err) => {
        console.error(`[SensorSimulator] 串口错误: ${err.message}`);
        this.emit('error', err);
      });

      this._running = true;
      console.log(`[SensorSimulator] 已启动: ${port} @ ${baudRate}`);
      this.emit('started', { port, baudRate });
    } catch (err) {
      console.error(`[SensorSimulator] 启动失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 停止模拟器
   */
  async stop() {
    if (!this._running) return;

    this._running = false;
    if (this._serialPort && this._serialPort.isOpen) {
      await new Promise((resolve) => this._serialPort.close(resolve));
    }
    this._serialPort = null;
    console.log('[SensorSimulator] 已停止');
    this.emit('stopped');
  }

  /**
   * 重置模拟器状态
   */
  async reset() {
    this._shadowRegisters.clear();
    this._faults.clear();
    this._sensorKeyMap.clear();
    this._transactionLog = [];
    this._currentFieldConfig = null;
    console.log('[SensorSimulator] 已重置');
  }

  // ============================================================
  // 场区配置
  // ============================================================

  /**
   * 加载场区配置
   * @param {string} fieldType 'A' | 'B' | 'C'
   */
  loadFieldConfig(fieldType) {
    // 避免重复加载同一场区（保留已设置的传感器值）
    if (this._loadedFieldType === fieldType && this._shadowRegisters.size > 0) {
      console.log(`[SensorSimulator] 场区 ${fieldType} 已加载，跳过重置`);
      return;
    }
    const configPath = `./fieldConfigs/fieldType${fieldType}`;
    let config;
    try {
      config = require(configPath);
    } catch (err) {
      throw new Error(`场区配置加载失败: ${fieldType} - ${err.message}`);
    }

    this._currentFieldConfig = config;

    // 保存已有的从站地址映射（固件 sensor_map.c 的地址可能与场区配置不同）
    const prevShadow = new Map(this._shadowRegisters);
    const prevKeyMap = new Map(this._sensorKeyMap);

    this._shadowRegisters.clear();
    this._sensorKeyMap.clear();

    // 初始化温湿度传感器影子寄存器（每个从站同时注册 temp_N 和 humi_N）
    for (const sensor of config.tempHumi.indoor) {
      const idx = sensor.index || parseInt(sensor.key.split('_')[1]);
      this._initSensor(sensor.key, sensor.slaveAddr, 0x0000, 2, 10);  // temp
      this._initSensor(`humi_${idx}`, sensor.slaveAddr, 0x0001, 1, 10);  // humi → register 1 (匹配固件 HUM_INDEX)
    }

    // 初始化 CO2 传感器 (固件 CO2_START_ADDR=0x0002)
    for (const sensor of config.co2) {
      this._initSensor(sensor.key, sensor.slaveAddr, 0x0002, 1, 1);
    }

    // 初始化压差传感器
    for (const sensor of config.pressure.indoor) {
      this._initSensor(sensor.key, sensor.slaveAddr, 0x0000, 1, 10);
    }

    // 初始化氨气传感器
    for (const sensor of config.nh3) {
      this._initSensor(sensor.key, sensor.slaveAddr, 0x0000, 1, 1);
    }

    // 合并回之前存在的从站地址（固件 sensor_map.c 的地址优先覆盖）
    for (const [addr, regs] of prevShadow) {
      this._shadowRegisters.set(addr, regs);
    }
    for (const [key, mapping] of prevKeyMap) {
      this._sensorKeyMap.set(key, mapping);
    }

    console.log(`[SensorSimulator] 已加载场区: ${config.name} (${fieldType}), 影子寄存器: ${this._shadowRegisters.size} 从站`);
    this._loadedFieldType = fieldType;
    this.emit('fieldLoaded', { fieldType, name: config.name });
  }

  /**
   * 初始化单个传感器的影子寄存器
   */
  _initSensor(key, slaveAddr, registerAddr, registerCount, scale) {
    if (!this._shadowRegisters.has(slaveAddr)) {
      this._shadowRegisters.set(slaveAddr, new Map());
    }
    const slaveRegs = this._shadowRegisters.get(slaveAddr);

    // 初始化默认值（25.0℃/50.0%RH 等）
    for (let i = 0; i < registerCount; i++) {
      slaveRegs.set(registerAddr + i, 0);
    }

    this._sensorKeyMap.set(key, { slaveAddr, registerAddr, registerCount, scale });
  }

  // ============================================================
  // 传感器值设置
  // ============================================================

  /**
   * 设置传感器值
   * @param {string} key 传感器标识（如 'temp_1', 'humi_1', 'co2_1'）
   * @param {number} value 工程值（如 25.0℃）
   */
  setSensorValue(key, value) {
    const mapping = this._sensorKeyMap.get(key);
    if (!mapping) {
      throw new Error(`传感器 key 未找到: ${key}`);
    }

    const { slaveAddr, registerAddr, scale } = mapping;
    const slaveRegs = this._shadowRegisters.get(slaveAddr);

    // 温度：int16, val*scale；湿度/压差：uint16, val*scale
    const rawValue = Math.round(value * scale);

    // 温湿度传感器：直接写入 registerAddr（由 _sensorKeyMap 设置正确的寄存器地址）
    slaveRegs.set(registerAddr, rawValue & 0xFFFF);

    // 清除该 key 的故障状态
    this._faults.delete(key);

    this._logTransaction({
      action: 'setSensorValue',
      key,
      value,
      rawValue,
      slaveAddr,
      registerAddr,
    });
  }

  /**
   * 设置温湿度对（同一从站的温度和湿度）
   * @param {string} tempKey
   * @param {number} tempValue
   * @param {string} humiKey
   * @param {number} humiValue
   */
  setTempHumiPair(tempKey, tempValue, humiKey, humiValue) {
    this.setSensorValue(tempKey, tempValue);
    this.setSensorValue(humiKey, humiValue);
  }

  // ============================================================
  // 故障注入
  // ============================================================

  /**
   * 注入超时故障（不响应）
   * @param {object} options
   * @param {string} options.key 传感器标识
   * @param {boolean} [options.persist=false] 是否跨重启保持
   */
  injectTimeout(options) {
    const { key, persist = false } = options;
    if (!this._sensorKeyMap.has(key)) {
      throw new Error(`传感器 key 未找到: ${key}`);
    }
    this._faults.set(key, { type: SENSOR_STATUS.TIMEOUT, persist, params: {} });
    this._logTransaction({ action: 'injectTimeout', key, persist });
    console.log(`[SensorSimulator] 注入超时: ${key} (persist=${persist})`);
  }

  /**
   * 注入固定值故障（连续返回相同值）
   * @param {object} options
   * @param {string} options.key
   * @param {number} options.value
   * @param {number} [options.repeat=100]
   */
  injectFixedValue(options) {
    const { key, value, repeat = 100 } = options;
    if (!this._sensorKeyMap.has(key)) {
      throw new Error(`传感器 key 未找到: ${key}`);
    }
    this.setSensorValue(key, value);
    this._faults.set(key, {
      type: SENSOR_STATUS.FIXED,
      persist: false,
      params: { value, repeat, count: 0 },
    });
    this._logTransaction({ action: 'injectFixedValue', key, value, repeat });
    console.log(`[SensorSimulator] 注入固定值: ${key} = ${value} (repeat=${repeat})`);
  }

  /**
   * 注入离群值
   * @param {object} options
   * @param {string} options.key
   * @param {number} options.value
   */
  injectOutlier(options) {
    const { key, value } = options;
    this.setSensorValue(key, value);
    this._faults.set(key, {
      type: SENSOR_STATUS.OUTLIER,
      persist: false,
      params: { value },
    });
    this._logTransaction({ action: 'injectOutlier', key, value });
    console.log(`[SensorSimulator] 注入离群值: ${key} = ${value}`);
  }

  /**
   * 注入 CRC 错误
   * @param {object} options
   * @param {string} options.key
   * @param {number} [options.count=3]
   */
  injectCrcError(options) {
    const { key, count = 3 } = options;
    if (!this._sensorKeyMap.has(key)) {
      throw new Error(`传感器 key 未找到: ${key}`);
    }
    this._faults.set(key, {
      type: SENSOR_STATUS.CRC_ERROR,
      persist: false,
      params: { count, sent: 0 },
    });
    this._logTransaction({ action: 'injectCrcError', key, count });
    console.log(`[SensorSimulator] 注入 CRC 错误: ${key} (count=${count})`);
  }

  /**
   * 清除故障
   * @param {string} key
   */
  clearFault(key) {
    this._faults.delete(key);
    this._logTransaction({ action: 'clearFault', key });
    console.log(`[SensorSimulator] 清除故障: ${key}`);
  }

  /**
   * 批量清除所有故障
   */
  clearAllFaults() {
    this._faults.clear();
    this._logTransaction({ action: 'clearAllFaults' });
    console.log('[SensorSimulator] 清除所有故障');
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取影子寄存器快照
   * @returns {object}
   */
  getShadowRegisters() {
    const result = {};
    for (const [slaveAddr, regs] of this._shadowRegisters) {
      result[`0x${slaveAddr.toString(16).padStart(2, '0')}`] = {};
      for (const [regAddr, value] of regs) {
        result[`0x${slaveAddr.toString(16).padStart(2, '0')}`][`0x${regAddr.toString(16).padStart(4, '0')}`] = value;
      }
    }
    return result;
  }

  /**
   * 获取交易日志
   * @param {object} [filter]
   * @param {string} [filter.key]
   * @param {string} [filter.action]
   * @returns {object[]}
   */
  getTransactionLog(filter) {
    let logs = this._transactionLog;
    if (filter) {
      if (filter.key) logs = logs.filter(l => l.key === filter.key);
      if (filter.action) logs = logs.filter(l => l.action === filter.action);
    }
    return logs;
  }

  /**
   * 获取故障状态
   * @returns {object}
   */
  getFaultStatus() {
    const result = {};
    for (const [key, fault] of this._faults) {
      result[key] = { ...fault };
    }
    return result;
  }

  /**
   * 获取当前场区配置
   * @returns {object|null}
   */
  getFieldConfig() {
    return this._currentFieldConfig;
  }

  // ============================================================
  // Mock 模式接口（无硬件测试用）
  // ============================================================

  /**
   * Mock 模式：模拟 Modbus RTU 读取响应
   * 返回指定从站地址和寄存器地址的原始值数组
   * @param {number} slaveAddr
   * @param {number} startAddr
   * @param {number} count
   * @returns {number[]|null} 寄存器值数组，null 表示超时不响应
   */
  mockReadHoldingRegisters(slaveAddr, startAddr, count) {
    // 检查该从站是否有故障
    const key = this._findSensorKey(slaveAddr);
    if (key) {
      const fault = this._faults.get(key);
      if (fault) {
        if (fault.type === SENSOR_STATUS.TIMEOUT) {
          this._logTransaction({
            action: 'mock_timeout',
            slaveAddr,
            startAddr,
            count,
            key,
          });
          return null;  // 超时不响应
        }
      }
    }

    // 从影子寄存器读取
    const slaveRegs = this._shadowRegisters.get(slaveAddr);
    if (!slaveRegs) return null;

    const values = [];
    for (let i = 0; i < count; i++) {
      values.push(slaveRegs.get(startAddr + i) || 0);
    }

    this._logTransaction({
      action: 'mock_read',
      slaveAddr,
      startAddr,
      count,
      values,
      key,
    });

    return values;
  }

  /**
   * Mock 模式：获取指定传感器 key 的当前值（工程值）
   * @param {string} key
   * @returns {number|null}
   */
  mockGetSensorValue(key) {
    const mapping = this._sensorKeyMap.get(key);
    if (!mapping) return null;

    const { slaveAddr, registerAddr, scale } = mapping;
    const slaveRegs = this._shadowRegisters.get(slaveAddr);
    if (!slaveRegs) return null;

    // 湿度在 registerAddr + 1
    const reg = key.startsWith('humi_') ? registerAddr + 1 : registerAddr;
    const raw = slaveRegs.get(reg);
    if (raw == null) return null;

    // 处理有符号值
    const signed = raw > 32767 ? raw - 65536 : raw;
    return signed / scale;
  }

  /**
   * 检查是否为 Mock 模式
   * @returns {boolean}
   */
  isMockMode() {
    return this._mockMode;
  }

  // ============================================================
  // Modbus RTU 从站处理
  // ============================================================

  /**
   * 串口数据接收处理
   * @param {Buffer} data
   */
  _onData(data) {
    this._rxBuffer = Buffer.concat([this._rxBuffer, data]);

    // Modbus RTU 帧最小长度：从站地址(1) + 功能码(1) + CRC(2) = 4
    while (this._rxBuffer.length >= 4) {
      // 尝试解析一个完整帧
      const frameLen = this._tryParseFrame();
      if (frameLen > 0) {
        this._rxBuffer = this._rxBuffer.slice(frameLen);
      } else if (frameLen === -1) {
        // 帧不完整，等待更多数据
        break;
      } else {
        // 无效帧，跳过第一个字节
        this._rxBuffer = this._rxBuffer.slice(1);
      }
    }
  }

  /**
   * 尝试解析 Modbus RTU 帧
   * @returns {number} 帧长度（>0），-1=不完整，0=无效
   */
  _tryParseFrame() {
    const buf = this._rxBuffer;
    if (buf.length < 4) return -1;

    const slaveAddr = buf[0];
    const funcCode = buf[1];

    // 功能码 0x03 / 0x04：读保持寄存器 / 读输入寄存器
    // 帧格式完全一致，共用同一套影子寄存器（压差传感器等使用 FC04）
    if (funcCode === 0x03 || funcCode === 0x04) {
      // 请求帧：从站地址(1) + 功能码(1) + 起始地址(2) + 寄存器数量(2) + CRC(2) = 8
      if (buf.length < 8) return -1;

      const startAddr = (buf[2] << 8) | buf[3];
      const regCount = (buf[4] << 8) | buf[5];

      // 验证 CRC
      const rxCrc = buf[6] | (buf[7] << 8);
      const calcCrc = crc16(buf.slice(0, 6));
      if (rxCrc !== calcCrc) {
        console.warn(`[SensorSimulator] CRC 错误: slave=0x${slaveAddr.toString(16)}, rx=0x${rxCrc.toString(16)}, calc=0x${calcCrc.toString(16)}`);
        return 8;  // 跳过这个帧
      }

      this._handleReadRegisters(slaveAddr, funcCode, startAddr, regCount);
      return 8;
    }

    // 功能码 0x06：写单个寄存器
    if (funcCode === 0x06) {
      if (buf.length < 8) return -1;
      const rxCrc = buf[6] | (buf[7] << 8);
      const calcCrc = crc16(buf.slice(0, 6));
      if (rxCrc !== calcCrc) return 8;

      // 写操作回显（模拟器通常不需要处理写，但要回 ACK）
      this._sendResponse(slaveAddr, funcCode, buf.slice(2, 6));
      return 8;
    }

    // 功能码 0x10：写多个寄存器
    if (funcCode === 0x10) {
      if (buf.length < 9) return -1;
      const byteCount = buf[6];
      const frameLen = 7 + byteCount + 2;  // 头 + 数据 + CRC
      if (buf.length < frameLen) return -1;

      const rxCrc = buf[frameLen - 2] | (buf[frameLen - 1] << 8);
      const calcCrc = crc16(buf.slice(0, frameLen - 2));
      if (rxCrc !== calcCrc) return frameLen;

      this._sendResponse(slaveAddr, funcCode, buf.slice(2, 6));
      return frameLen;
    }

    // 不支持的功能码
    this._sendException(slaveAddr, funcCode, 0x01);  // ILLEGAL FUNCTION
    return 8;
  }

  /**
   * 处理读寄存器请求（FC03 保持寄存器 / FC04 输入寄存器）
   */
  _handleReadRegisters(slaveAddr, funcCode, startAddr, regCount) {
    const key = this._findSensorKey(slaveAddr);

    // 检查故障状态
    if (key) {
      const fault = this._faults.get(key);
      if (fault) {
        if (fault.type === SENSOR_STATUS.TIMEOUT) {
          // 超时不响应
          this._logTransaction({
            action: 'timeout_no_response',
            slaveAddr,
            startAddr,
            regCount,
            key,
          });
          return;
        }
        if (fault.type === SENSOR_STATUS.CRC_ERROR) {
          // 发送错误 CRC 响应
          if (fault.params.sent < fault.params.count) {
            fault.params.sent++;
            this._sendCrcErrorResponse(slaveAddr, funcCode, startAddr, regCount);
            this._logTransaction({
              action: 'crc_error_response',
              slaveAddr,
              startAddr,
              regCount,
              key,
              remaining: fault.params.count - fault.params.sent,
            });
            return;
          }
          // CRC 错误次数用完，恢复正常
          this._faults.delete(key);
        }
      }
    }

    // 从影子寄存器读取数据
    const slaveRegs = this._shadowRegisters.get(slaveAddr);
    if (!slaveRegs) {
      // 未知从站地址，不响应
      this._logTransaction({
        action: 'unknown_slave',
        slaveAddr,
        startAddr,
        regCount,
      });
      return;
    }

    const values = [];
    for (let i = 0; i < regCount; i++) {
      values.push(slaveRegs.get(startAddr + i) || 0);
    }

    // 构建响应
    const byteCount = regCount * 2;
    const respData = Buffer.alloc(1 + byteCount);
    respData[0] = byteCount;
    for (let i = 0; i < regCount; i++) {
      respData[1 + i * 2] = (values[i] >> 8) & 0xFF;
      respData[2 + i * 2] = values[i] & 0xFF;
    }

    this._sendResponse(slaveAddr, funcCode, respData);

    this._logTransaction({
      action: 'read_response',
      slaveAddr,
      startAddr,
      regCount,
      values,
      key,
    });
  }

  /**
   * 查找从站地址对应的传感器 key
   */
  _findSensorKey(slaveAddr) {
    for (const [key, mapping] of this._sensorKeyMap) {
      if (mapping.slaveAddr === slaveAddr) return key;
    }
    return null;
  }

  /**
   * 发送 Modbus RTU 响应
   */
  _sendResponse(slaveAddr, funcCode, data) {
    if (!this._serialPort || !this._serialPort.isOpen) return;

    const resp = Buffer.alloc(2 + data.length + 2);
    resp[0] = slaveAddr;
    resp[1] = funcCode;
    data.copy(resp, 2);
    const crc = crc16(resp.slice(0, 2 + data.length));
    resp[2 + data.length] = crc & 0xFF;
    resp[3 + data.length] = (crc >> 8) & 0xFF;

    // Modbus RTU 要求：从站等待 3.5 字符时间静默后才发送响应
    // 9600bps 下 3.5 字符 ≈ 3.64ms，这里用 5ms 保证余量
    setTimeout(() => {
      if (this._serialPort && this._serialPort.isOpen) {
        console.log(`[SimTX] slave=0x${slaveAddr.toString(16)} resp=${resp.toString('hex')}`);
        this._serialPort.write(resp, (err) => {
          if (err) console.error(`[SimTX] Write error: ${err.message}`);
          else console.log(`[SimTX] Write OK, ${resp.length} bytes`);
        });
      } else {
        console.log(`[SimTX] SKIPPED: port not open`);
      }
    }, 20);
  }

  /**
   * 发送异常响应
   */
  _sendException(slaveAddr, funcCode, exceptionCode) {
    if (!this._serialPort || !this._serialPort.isOpen) return;

    const resp = Buffer.alloc(5);
    resp[0] = slaveAddr;
    resp[1] = funcCode | 0x80;
    resp[2] = exceptionCode;
    const crc = crc16(resp.slice(0, 3));
    resp[3] = crc & 0xFF;
    resp[4] = (crc >> 8) & 0xFF;

    setTimeout(() => {
      if (this._serialPort && this._serialPort.isOpen) {
        console.log(`[SimTX] slave=0x${slaveAddr.toString(16)} resp=${resp.toString('hex')}`);
        this._serialPort.write(resp, (err) => {
          if (err) console.error(`[SimTX] Write error: ${err.message}`);
          else console.log(`[SimTX] Write OK, ${resp.length} bytes`);
        });
      } else {
        console.log(`[SimTX] SKIPPED: port not open`);
      }
    }, 20);
  }

  /**
   * 发送 CRC 错误响应（故意损坏 CRC）
   */
  _sendCrcErrorResponse(slaveAddr, funcCode, startAddr, regCount) {
    if (!this._serialPort || !this._serialPort.isOpen) return;

    const byteCount = regCount * 2;
    const resp = Buffer.alloc(3 + byteCount + 2);
    resp[0] = slaveAddr;
    resp[1] = funcCode;
    resp[2] = byteCount;

    // 填充数据
    const slaveRegs = this._shadowRegisters.get(slaveAddr);
    for (let i = 0; i < regCount; i++) {
      const val = slaveRegs ? (slaveRegs.get(startAddr + i) || 0) : 0;
      resp[3 + i * 2] = (val >> 8) & 0xFF;
      resp[4 + i * 2] = val & 0xFF;
    }

    // 故意写入错误的 CRC
    resp[resp.length - 2] = 0x00;
    resp[resp.length - 1] = 0x00;

    this._serialPort.write(resp);
  }

  // ============================================================
  // 交易日志
  // ============================================================

  _logTransaction(entry) {
    this._transactionLog.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });

    // 限制日志大小
    if (this._transactionLog.length > this._maxLogSize) {
      this._transactionLog = this._transactionLog.slice(-this._maxLogSize);
    }
  }
}

module.exports = SensorSimulator;
module.exports.SENSOR_STATUS = SENSOR_STATUS;
module.exports.crc16 = crc16;
