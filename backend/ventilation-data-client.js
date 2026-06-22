/**
 * backend/ventilation-data-client.js
 * 通风逻辑表 TCP 客户端
 *
 * 职责：
 *   1. 通过独立 TCP 端口(1503)与环控器通信，传输通风逻辑表数据
 *   2. 维护连接状态、请求队列、超时处理
 *   3. 支持读取/写入单条或多条通风等级逻辑表
 *   4. vt_t 结构体序列化/反序列化
 *
 * 开发依据：
 *   - 通风逻辑表 TCP 传输协议规范
 *   - shared/ventilation-protocol.js
 *   - backend/ate/AteTcpClient.js（TCP 客户端模式参考）
 *
 * 更新历史：
 *   v1.0  2026-06-22  初始版本，支持连接管理、命令收发、批量读写
 */

'use strict';

const net = require('net');
const {
  MAGIC,
  PORT,
  CMD,
  VT_T_FIELDS,
  VT_T_SIZE,
  MAX_LEVELS,
  HEADER_SIZE,
  CRC_SIZE,
  crc16,
  buildPacket,
  parsePacket,
} = require('../shared/ventilation-protocol');

/**
 * 通风逻辑表 TCP 客户端
 * 管理与环控器的通风逻辑表传输连接
 */
class VentilationDataClient {
  /**
   * @param {object} options
   * @param {string} [options.host] - 设备 IP 地址，默认 192.168.10.233
   * @param {number} [options.port] - TCP 端口，默认 1503
   * @param {number} [options.timeout] - 命令响应超时时间（ms），默认 5000
   */
  constructor(options = {}) {
    this.host = options.host || '192.168.10.233';
    this.port = options.port || PORT;
    this.timeout = options.timeout || 5000;

    /**
     * TCP 连接对象
     */
    this.socket = null;

    /**
     * 连接状态
     */
    this._connected = false;

    /**
     * 接收缓冲区（处理 TCP 粘包/分包）
     */
    this._recvBuffer = Buffer.alloc(0);

    /**
     * 待响应请求：{ resolve, reject, timer }
     */
    this._pendingRequest = null;

    /**
     * 统计信息
     */
    this._stats = {
      connectCount: 0,
      disconnectCount: 0,
      commandsSent: 0,
      responsesReceived: 0,
      errors: 0,
    };

    // 绑定内部方法
    this._onData = this._onData.bind(this);
    this._onClose = this._onClose.bind(this);
    this._onError = this._onError.bind(this);
  }

  // ============================================================
  // 连接管理
  // ============================================================

  /**
   * 连接到环控器 TCP 服务
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this._connected && this.socket) {
        resolve();
        return;
      }

      this.socket = new net.Socket();
      this.socket.setKeepAlive(true, 10000);
      this.socket.setTimeout(10000);

      const onConnectTimeout = () => {
        this.socket.destroy();
        reject(new Error(`连接超时：${this.host}:${this.port}`));
      };

      this.socket.setTimeout(10000);
      this.socket.once('timeout', onConnectTimeout);

      this.socket.connect(this.port, this.host, () => {
        this.socket.removeListener('timeout', onConnectTimeout);
        this._connected = true;
        this._recvBuffer = Buffer.alloc(0);
        this._stats.connectCount++;

        this.socket.on('data', this._onData);
        this.socket.on('close', this._onClose);
        this.socket.on('error', this._onError);

        resolve();
      });

      this.socket.once('error', (err) => {
        this.socket.removeListener('timeout', onConnectTimeout);
        reject(err);
      });
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    this._rejectPending('客户端主动断开');

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this._connected = false;
    this._recvBuffer = Buffer.alloc(0);
    this._stats.disconnectCount++;
  }

  /**
   * 是否已连接
   * @returns {boolean}
   */
  isConnected() {
    return this._connected && this.socket !== null;
  }

  /**
   * 获取连接状态和统计信息
   * @returns {object}
   */
  getStatus() {
    return {
      host: this.host,
      port: this.port,
      connected: this._connected,
      stats: { ...this._stats },
    };
  }

  // ============================================================
  // 命令收发
  // ============================================================

  /**
   * 发送命令并等待响应
   *
   * @param {number} cmd - 命令字 (CMD)
   * @param {Buffer} [data] - 命令负载
   * @param {number} [timeoutMs] - 超时时间（ms），默认使用 this.timeout
   * @returns {Promise<{ cmd: number, data: Buffer }>} 响应数据
   */
  sendCommand(cmd, data, timeoutMs) {
    if (!this._connected) {
      return Promise.reject(new Error('未连接到设备'));
    }

    const timeout = timeoutMs || this.timeout;

    return new Promise((resolve, reject) => {
      // 拒绝之前的未完成请求
      this._rejectPending('新命令覆盖旧请求');

      // 创建超时定时器
      const timer = setTimeout(() => {
        this._pendingRequest = null;
        reject(new Error(`命令响应超时：0x${cmd.toString(16).padStart(2, '0')}`));
      }, timeout);

      this._pendingRequest = { resolve, reject, timer };

      try {
        const packet = buildPacket(cmd, data);
        this.socket.write(packet);
        this._stats.commandsSent++;
      } catch (err) {
        clearTimeout(timer);
        this._pendingRequest = null;
        reject(err);
      }
    });
  }

  // ============================================================
  // 逻辑表读写
  // ============================================================

  /**
   * 读取指定通风等级的逻辑表
   *
   * 请求格式：[levelIndex(1B)]
   *   levelIndex = 0~29：读取单条
   *   levelIndex = 0xFF：读取全部（MAX_LEVELS 条）
   *
   * 响应格式：[count(1B)] + [levelIndex(1B) + vt_t(VT_T_SIZE)] * count
   *
   * @param {number} [levelIndex] - 等级索引 0~29，或 0xFF 读取全部，默认 0xFF
   * @returns {Promise<Array<{ index: number, data: object }>>} 逻辑表数据数组
   */
  async readLogicTable(levelIndex = 0xFF) {
    const reqData = Buffer.from([levelIndex & 0xFF]);
    const resp = await this.sendCommand(CMD.READ_LOGIC_TABLE, reqData);

    if (resp.cmd === CMD.NAK) {
      throw new Error('固件拒绝读取请求 (NAK)');
    }

    if (resp.cmd !== CMD.RESPONSE_LOGIC_TABLE) {
      throw new Error(`意外的响应命令：0x${resp.cmd.toString(16).padStart(2, '0')}`);
    }

    return this._parseLogicTableResponse(resp.data);
  }

  /**
   * 写入单个通风等级的逻辑表
   *
   * 请求格式：[levelIndex(1B)] + [vt_t(VT_T_SIZE)]
   *
   * @param {number} levelIndex - 等级索引 0~29
   * @param {object} levelData - vt_t 数据对象
   * @returns {Promise<boolean>} 写入是否成功
   */
  async writeLogicTable(levelIndex, levelData) {
    if (levelIndex < 0 || levelIndex >= MAX_LEVELS) {
      throw new Error(`等级索引超出范围：${levelIndex}，有效范围 0~${MAX_LEVELS - 1}`);
    }

    const vtBuffer = this._serializeVtT(levelData);
    const reqData = Buffer.alloc(1 + VT_T_SIZE);
    reqData.writeUInt8(levelIndex, 0);
    vtBuffer.copy(reqData, 1);

    const resp = await this.sendCommand(CMD.WRITE_LOGIC_TABLE, reqData);

    if (resp.cmd === CMD.ACK) {
      return true;
    }
    if (resp.cmd === CMD.NAK) {
      throw new Error('固件拒绝写入请求 (NAK)');
    }
    throw new Error(`意外的响应命令：0x${resp.cmd.toString(16).padStart(2, '0')}`);
  }

  /**
   * 批量写入逻辑表
   *
   * @param {Array<{ index: number, data: object }>} levels - 等级数据数组
   * @returns {Promise<{ success: number, failed: number }>} 写入统计
   */
  async writeLogicTableBatch(levels) {
    let success = 0;
    let failed = 0;

    for (const level of levels) {
      try {
        await this.writeLogicTable(level.index, level.data);
        success++;
      } catch (err) {
        failed++;
        console.error(`[VentData] 写入等级 ${level.index} 失败: ${err.message}`);
      }
    }

    return { success, failed };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 拒绝挂起的请求
   * @param {string} reason
   * @private
   */
  _rejectPending(reason) {
    if (this._pendingRequest) {
      clearTimeout(this._pendingRequest.timer);
      this._pendingRequest.reject(new Error(reason));
      this._pendingRequest = null;
    }
  }

  /**
   * 处理接收到的 TCP 数据
   * @param {Buffer} data
   * @private
   */
  _onData(data) {
    // 追加到接收缓冲区
    this._recvBuffer = Buffer.concat([this._recvBuffer, data]);

    // 尝试解析完整帧
    this._tryParseFrame();
  }

  /**
   * 尝试从接收缓冲区解析一个完整帧
   * @private
   */
  _tryParseFrame() {
    // 至少需要帧头 + CRC
    const minSize = HEADER_SIZE + CRC_SIZE;
    if (this._recvBuffer.length < minSize) {
      return;
    }

    // 检查魔数
    const magic = this._recvBuffer.readUInt16LE(0);
    if (magic !== MAGIC) {
      // 丢弃不合法数据，尝试找到下一个魔数
      const idx = this._findMagic(this._recvBuffer);
      if (idx > 0) {
        this._recvBuffer = this._recvBuffer.subarray(idx);
      } else {
        this._recvBuffer = Buffer.alloc(0);
      }
      return;
    }

    // 读取数据长度
    const dataLength = this._recvBuffer.readUInt16LE(3);
    const totalSize = HEADER_SIZE + dataLength + CRC_SIZE;

    // 检查是否收到完整帧
    if (this._recvBuffer.length < totalSize) {
      return;
    }

    // 提取完整帧
    const frameBuffer = this._recvBuffer.subarray(0, totalSize);
    this._recvBuffer = this._recvBuffer.subarray(totalSize);

    // 解析帧（parsePacket 在 CRC 失败时返回 null）
    const parsed = parsePacket(frameBuffer);
    if (!parsed) {
      this._stats.errors++;
      return;
    }

    this._stats.responsesReceived++;

    // 分发到待响应请求
    if (this._pendingRequest) {
      clearTimeout(this._pendingRequest.timer);
      const pending = this._pendingRequest;
      this._pendingRequest = null;
      pending.resolve({ cmd: parsed.cmd, data: parsed.data });
    }
  }

  /**
   * 在缓冲区中查找魔数位置
   * @param {Buffer} buf
   * @returns {number} 魔数偏移量，找不到返回 -1
   * @private
   */
  _findMagic(buf) {
    const magicLo = MAGIC & 0xFF;
    const magicHi = (MAGIC >> 8) & 0xFF;

    for (let i = 0; i <= buf.length - 2; i++) {
      if (buf[i] === magicLo && buf[i + 1] === magicHi) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 处理连接关闭
   * @private
   */
  _onClose() {
    this._connected = false;
    this._rejectPending('连接关闭');
    this._recvBuffer = Buffer.alloc(0);
    this._stats.disconnectCount++;
  }

  /**
   * 处理连接错误
   * @param {Error} err
   * @private
   */
  _onError(err) {
    this._stats.errors++;
    console.error(`[VentData] 连接错误: ${err.message}`);
  }

  // ============================================================
  // vt_t 序列化/反序列化
  // ============================================================

  /**
   * 将 vt_t 对象序列化为 Buffer
   *
   * @param {object} vt - vt_t 数据对象
   * @returns {Buffer} 序列化后的 Buffer（VT_T_SIZE 字节）
   * @private
   */
  _serializeVtT(vt) {
    const buf = Buffer.alloc(VT_T_SIZE);
    let offset = 0;

    for (const field of VT_T_FIELDS) {
      const value = vt[field.name];

      switch (field.type) {
        case 'uint8':
          buf.writeUInt8(value || 0, offset);
          offset += field.size;
          break;

        case 'uint8[]': {
          const arr = value || new Array(field.size).fill(0);
          for (let i = 0; i < field.size; i++) {
            buf.writeUInt8(arr[i] || 0, offset + i);
          }
          offset += field.size;
          break;
        }

        case 'uint16':
          buf.writeUInt16LE(value || 0, offset);
          offset += field.size;
          break;

        case 'uint32':
          buf.writeUInt32LE(value || 0, offset);
          offset += field.size;
          break;

        case 'float':
          buf.writeFloatLE(value || 0, offset);
          offset += field.size;
          break;

        default:
          offset += field.size;
          break;
      }
    }

    return buf;
  }

  /**
   * 将 Buffer 反序列化为 vt_t 对象
   *
   * @param {Buffer} buf - 原始数据（VT_T_SIZE 字节）
   * @param {number} [offset=0] - 起始偏移量
   * @returns {object} vt_t 数据对象
   * @private
   */
  _deserializeVtT(buf, offset = 0) {
    const result = {};
    let pos = offset;

    for (const field of VT_T_FIELDS) {
      switch (field.type) {
        case 'uint8':
          result[field.name] = buf.readUInt8(pos);
          pos += field.size;
          break;

        case 'uint8[]': {
          const arr = [];
          for (let i = 0; i < field.size; i++) {
            arr.push(buf.readUInt8(pos + i));
          }
          result[field.name] = arr;
          pos += field.size;
          break;
        }

        case 'uint16':
          result[field.name] = buf.readUInt16LE(pos);
          pos += field.size;
          break;

        case 'uint32':
          result[field.name] = buf.readUInt32LE(pos);
          pos += field.size;
          break;

        case 'float':
          result[field.name] = buf.readFloatLE(pos);
          pos += field.size;
          break;

        default:
          pos += field.size;
          break;
      }
    }

    return result;
  }

  /**
   * 解析固件返回的逻辑表响应数据
   *
   * 响应格式：[count(1B)] + [levelIndex(1B) + vt_t(VT_T_SIZE)] * count
   *
   * @param {Buffer} data - 响应负载
   * @returns {Array<{ index: number, data: object }>} 解析后的逻辑表数组
   * @private
   */
  _parseLogicTableResponse(data) {
    if (data.length < 1) {
      return [];
    }

    const count = data.readUInt8(0);
    const result = [];
    let offset = 1;

    for (let i = 0; i < count; i++) {
      if (offset + 1 + VT_T_SIZE > data.length) {
        console.warn(`[VentData] 响应数据不完整，已解析 ${i}/${count} 条`);
        break;
      }

      const levelIndex = data.readUInt8(offset);
      offset += 1;

      const levelData = this._deserializeVtT(data, offset);
      offset += VT_T_SIZE;

      result.push({ index: levelIndex, data: levelData });
    }

    return result;
  }
}

module.exports = VentilationDataClient;
