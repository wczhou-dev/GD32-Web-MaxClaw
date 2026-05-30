/**
 * backend/ate/AteTcpClient.js
 * ATE TCP 客户端
 *
 * 职责：
 *   1. 连接环控器固件 ATE TCP 服务 (默认端口 9001)
 *   2. 维护连接状态、心跳、请求队列
 *   3. 通过 messageId 匹配请求与 ACK
 *   4. ACK 超时处理 (默认 2 秒)
 *   5. 12 秒冷却重连策略
 *   6. 推送原始帧日志到 WebSocket
 *
 * 开发依据：
 *   - P0 方案第 4 章：TCP+JSON ATE 协议规范
 *   - P0 方案第 17 章：环控器固件接口定义
 *   - shared/constants.js：ATE_FRAME, ATE_CMD, ATE_METHOD
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，支持请求队列、ACK 匹配、超时处理
 */

'use strict';

const net = require('net');
const EventEmitter = require('events');
const AteFrameCodec = require('./AteFrameCodec');
const {
  ATE_CMD,
  ATE_METHOD,
  CONFIG_DEFAULTS,
} = require('../../shared/constants');

/**
 * ATE TCP 客户端
 * 管理与环控器固件的 TCP+JSON 连接
 */
class AteTcpClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.deviceIp - 设备 IP 地址
   * @param {number} [options.port] - TCP 端口，默认 9001
   * @param {number} [options.ackTimeoutMs] - ACK 超时时间，默认 2000ms
   * @param {number} [options.reconnectCooldownMs] - 重连冷却时间，默认 12000ms
   * @param {number} [options.heartbeatIntervalMs] - 心跳间隔，默认 5000ms
   * @param {boolean} [options.enableRawFrameLog] - 是否推送原始帧日志，默认 false
   */
  constructor(options = {}) {
    super();

    this._deviceIp = options.deviceIp || CONFIG_DEFAULTS.DEVICE_IP;
    this._port = options.port || CONFIG_DEFAULTS.ATE_TCP_PORT;
    this._ackTimeoutMs = options.ackTimeoutMs || CONFIG_DEFAULTS.ATE_ACK_TIMEOUT_MS;
    this._reconnectCooldownMs = options.reconnectCooldownMs || CONFIG_DEFAULTS.ATE_RECONNECT_COOLDOWN_MS;
    this._heartbeatIntervalMs = options.heartbeatIntervalMs || 5000;
    this._enableRawFrameLog = options.enableRawFrameLog || false;

    /**
     * TCP 连接对象
     */
    this._socket = null;

    /**
     * 帧编解码器
     */
    this._codec = new AteFrameCodec();

    /**
     * 连接状态
     */
    this._connected = false;

    /**
     * 消息 ID 计数器（用于 ACK 匹配）
     */
    this._messageIdCounter = 0;

    /**
     * 待确认请求队列：messageId -> { resolve, reject, timer, method, timestamp }
     */
    this._pendingRequests = new Map();

    /**
     * 心跳定时器
     */
    this._heartbeatTimer = null;

    /**
     * 重连冷却定时器
     */
    this._cooldownTimer = null;

    /**
     * 最后断开时间（用于冷却判断）
     */
    this._lastDisconnectTime = 0;

    /**
     * 统计信息
     */
    this._stats = {
      connectCount: 0,
      disconnectCount: 0,
      messagesSent: 0,
      messagesReceived: 0,
      ackReceived: 0,
      ackTimeout: 0,
      heartbeats: 0,
    };

    // 绑定方法
    this._onData = this._onData.bind(this);
    this._onClose = this._onClose.bind(this);
    this._onError = this._onError.bind(this);
  }

  // ============================================================
  // 公共方法
  // ============================================================

  /**
   * 连接到设备
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      // 检查冷却期
      if (this._isInCooldown()) {
        const remainingMs = this._reconnectCooldownMs - (Date.now() - this._lastDisconnectTime);
        reject(new Error(`连接冷却中，剩余 ${remainingMs}ms`));
        return;
      }

      // 如果已连接，直接返回
      if (this._connected && this._socket) {
        resolve();
        return;
      }

      // 创建 TCP 连接
      this._socket = new net.Socket();
      this._socket.setKeepAlive(true, 10000);

      // 设置超时
      this._socket.setTimeout(10000);

      this._socket.connect(this._port, this._deviceIp, () => {
        this._connected = true;
        this._stats.connectCount++;
        this._lastDisconnectTime = 0;

        // 绑定事件
        this._socket.on('data', this._onData);
        this._socket.on('close', this._onClose);
        this._socket.on('error', this._onError);

        // 启动心跳
        this._startHeartbeat();

        this.emit('connected', { deviceIp: this._deviceIp, port: this._port });
        resolve();
      });

      this._socket.on('timeout', () => {
        this._socket.destroy();
        reject(new Error(`连接超时：${this._deviceIp}:${this._port}`));
      });

      // 处理连接前的错误
      this._socket.once('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    this._stopHeartbeat();
    this._rejectAllPending('客户端主动断开');

    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }

    this._connected = false;
    this._lastDisconnectTime = Date.now();
    this._stats.disconnectCount++;

    this.emit('disconnected', { deviceIp: this._deviceIp });
  }

  /**
   * 是否已连接
   */
  isConnected() {
    return this._connected && this._socket !== null;
  }

  /**
   * 获取连接状态
   */
  getStatus() {
    return {
      deviceIp: this._deviceIp,
      port: this._port,
      connected: this._connected,
      pendingRequests: this._pendingRequests.size,
      stats: { ...this._stats },
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * 设置原始帧日志开关
   */
  setRawFrameLogEnabled(enabled) {
    this._enableRawFrameLog = enabled;
  }

  // ============================================================
  // 请求方法
  // ============================================================

  /**
   * 发送请求并等待 ACK
   * @param {string} method - 请求方法 (ATE_METHOD)
   * @param {object} params - 请求参数
   * @param {number} [timeoutMs] - 超时时间，默认使用 ACK 超时设置
   * @returns {Promise<object>} ACK 响应数据
   */
  async request(method, params = {}, timeoutMs = null) {
    if (!this._connected) {
      throw new Error('未连接到设备');
    }

    const messageId = this._nextMessageId();
    const timeout = timeoutMs || this._ackTimeoutMs;

    return new Promise((resolve, reject) => {
      // 创建超时定时器
      const timer = setTimeout(() => {
        this._pendingRequests.delete(messageId);
        this._stats.ackTimeout++;
        reject(new Error(`ACK 超时：${method} (messageId: ${messageId})`));
      }, timeout);

      // 加入待确认队列
      this._pendingRequests.set(messageId, {
        resolve,
        reject,
        timer,
        method,
        timestamp: Date.now(),
      });

      // 编码并发送帧
      try {
        const frame = this._codec.encodeDownlink(method, params, messageId);
        this._socket.write(frame);
        this._stats.messagesSent++;
      } catch (err) {
        clearTimeout(timer);
        this._pendingRequests.delete(messageId);
        reject(err);
      }
    });
  }

  /**
   * 进入测试模式
   * @returns {Promise<object>}
   */
  async enterTestMode() {
    return this.request(ATE_METHOD.TEST_ENTER);
  }

  /**
   * 退出测试模式
   * @returns {Promise<object>}
   */
  async exitTestMode() {
    return this.request(ATE_METHOD.TEST_EXIT);
  }

  /**
   * 开始测试
   * @param {number} testMask - 测试掩码
   * @returns {Promise<object>}
   */
  async startTest(testMask) {
    return this.request(ATE_METHOD.TEST_START, { testMask });
  }

  /**
   * 停止测试
   * @returns {Promise<object>}
   */
  async stopTest() {
    return this.request(ATE_METHOD.TEST_STOP);
  }

  /**
   * 复位测试状态
   * @returns {Promise<object>}
   */
  async resetTest() {
    return this.request(ATE_METHOD.TEST_RESET);
  }

  /**
   * 批量读取属性
   * @param {Array<string>} properties - 属性名列表
   * @returns {Promise<object>}
   */
  async getProperties(properties) {
    return this.request(ATE_METHOD.PROPERTIES_GET, { properties });
  }

  /**
   * 写入配置参数
   * @param {object} config - 配置参数
   * @returns {Promise<object>}
   */
  async writeConfig(config) {
    return this.request(ATE_METHOD.CONFIG_WRITE, { config });
  }

  /**
   * 强制 IO 输出
   * @param {object} outputs - 输出配置
   * @param {number} [timeoutMs] - 超时时间
   * @returns {Promise<object>}
   */
  async forceIo(outputs, timeoutMs = 5000) {
    return this.request(ATE_METHOD.CONTROL_FORCE_IO, { outputs, timeoutMs }, timeoutMs);
  }

  /**
   * 发送心跳
   * @returns {Promise<void>}
   */
  async sendHeartbeat() {
    if (!this._connected) {
      return;
    }

    try {
      const frame = this._codec.encodeHeartbeat(this._deviceIp);
      this._socket.write(frame);
      this._stats.heartbeats++;
    } catch (err) {
      this.emit('error', err);
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 生成下一个消息 ID
   * @returns {number}
   * @private
   */
  _nextMessageId() {
    this._messageIdCounter = (this._messageIdCounter + 1) & 0xFFFF;
    if (this._messageIdCounter === 0) {
      this._messageIdCounter = 1;
    }
    return this._messageIdCounter;
  }

  /**
   * 检查是否在冷却期
   * @returns {boolean}
   * @private
   */
  _isInCooldown() {
    if (this._lastDisconnectTime === 0) {
      return false;
    }
    return (Date.now() - this._lastDisconnectTime) < this._reconnectCooldownMs;
  }

  /**
   * 启动心跳
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this._heartbeatIntervalMs);
  }

  /**
   * 停止心跳
   * @private
   */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * 拒绝所有待确认请求
   * @param {string} reason - 拒绝原因
   * @private
   */
  _rejectAllPending(reason) {
    for (const [messageId, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pendingRequests.clear();
  }

  /**
   * 处理接收到的数据
   * @param {Buffer} data
   * @private
   */
  _onData(data) {
    this._stats.messagesReceived++;

    // 推送原始帧日志
    if (this._enableRawFrameLog) {
      this.emit('raw_frame', {
        deviceIp: this._deviceIp,
        direction: 'inbound',
        hex: data.toString('hex'),
        timestamp: Date.now(),
      });
    }

    // 解码帧
    const frames = this._codec.feed(data);

    for (const frame of frames) {
      this._handleFrame(frame);
    }
  }

  /**
   * 处理解码后的帧
   * @param {object} frame - 解码后的帧对象
   * @private
   */
  _handleFrame(frame) {
    const { cmdType, payload } = frame;

    switch (cmdType) {
      case ATE_CMD.ACK:
      case ATE_CMD.NACK:
        this._handleAck(frame);
        break;

      case ATE_CMD.REPORT:
        this._handleReport(payload);
        break;

      case ATE_CMD.ERROR:
        this._handleError(payload);
        break;

      case ATE_CMD.HEARTBEAT:
        this.emit('heartbeat', payload);
        break;

      default:
        this.emit('unknown_frame', frame);
        break;
    }
  }

  /**
   * 处理 ACK/NACK 响应
   * @param {object} frame
   * @private
   */
  _handleAck(frame) {
    const { cmdType, payload } = frame;
    const { messageId } = payload;

    if (messageId === undefined || !this._pendingRequests.has(messageId)) {
      return;
    }

    const pending = this._pendingRequests.get(messageId);
    clearTimeout(pending.timer);
    this._pendingRequests.delete(messageId);
    this._stats.ackReceived++;

    if (cmdType === ATE_CMD.ACK) {
      pending.resolve(payload);
    } else {
      pending.reject(new Error(payload.message || 'NACK'));
    }
  }

  /**
   * 处理固件主动上报 (report)
   * @param {object} payload
   * @private
   */
  _handleReport(payload) {
    this.emit('report', {
      deviceIp: this._deviceIp,
      ...payload,
    });
  }

  /**
   * 处理错误响应
   * @param {object} payload
   * @private
   */
  _handleError(payload) {
    this.emit('device_error', {
      deviceIp: this._deviceIp,
      ...payload,
    });
  }

  /**
   * 处理连接关闭
   * @private
   */
  _onClose() {
    this._connected = false;
    this._lastDisconnectTime = Date.now();
    this._stats.disconnectCount++;

    this._stopHeartbeat();
    this._rejectAllPending('连接关闭');
    this._codec.clearBuffer();

    this.emit('disconnected', { deviceIp: this._deviceIp });
  }

  /**
   * 处理连接错误
   * @param {Error} err
   * @private
   */
  _onError(err) {
    this.emit('error', {
      deviceIp: this._deviceIp,
      error: err,
    });
  }
}

module.exports = AteTcpClient;
