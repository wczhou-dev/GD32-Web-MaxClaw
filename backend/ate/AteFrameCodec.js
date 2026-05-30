/**
 * backend/ate/AteFrameCodec.js
 * ATE TCP+JSON 帧编解码器
 *
 * 职责：
 *   1. 编码 ATE 帧：Magic(0x55AA) + CmdType(2) + Length(2) + JSON Payload
 *   2. 解码 ATE 帧：处理半包、粘包、多帧连续到达
 *   3. 异常处理：坏 Magic 丢弃、长度超限、JSON 解析失败
 *
 * 帧格式 (Big-Endian)：
 *   ┌─────────┬─────────┬─────────┬─────────────┐
 *   │ Magic   │ CmdType │ Length  │ JSON Payload │
 *   │ 2 bytes │ 2 bytes │ 2 bytes │ N bytes     │
 *   └─────────┴─────────┴─────────┴─────────────┘
 *
 * 开发依据：
 *   - P0 方案第 4 章：TCP+JSON ATE 协议规范
 *   - shared/constants.js：ATE_FRAME, ATE_CMD
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，支持流式解析、半包粘包处理
 */

'use strict';

const { ATE_FRAME, ATE_CMD } = require('../../shared/constants');

/**
 * ATE 帧编解码器
 * 使用流式 Buffer 缓存处理 TCP 分包场景
 */
class AteFrameCodec {
  constructor() {
    /**
     * 接收缓冲区：用于处理半包、粘包
     * 每次收到数据时追加到缓冲区，解码时从中提取完整帧
     */
    this._buffer = Buffer.alloc(0);

    /**
     * 统计信息
     */
    this._stats = {
      framesEncoded: 0,
      framesDecoded: 0,
      badMagicDropped: 0,
      lengthExceeded: 0,
      jsonParseErrors: 0,
      incompleteFrames: 0,
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this._stats = {
      framesEncoded: 0,
      framesDecoded: 0,
      badMagicDropped: 0,
      lengthExceeded: 0,
      jsonParseErrors: 0,
      incompleteFrames: 0,
    };
  }

  // ============================================================
  // 编码方法
  // ============================================================

  /**
   * 编码 ATE 帧
   * @param {number} cmdType - 命令类型 (ATE_CMD 常量)
   * @param {object|string} payload - JSON 负载对象或已序列化的字符串
   * @returns {Buffer} 编码后的完整帧
   * @throws {Error} 参数错误或负载过大
   */
  encode(cmdType, payload) {
    // 序列化 JSON 负载
    let jsonStr;
    if (typeof payload === 'string') {
      jsonStr = payload;
    } else if (typeof payload === 'object' && payload !== null) {
      jsonStr = JSON.stringify(payload);
    } else {
      throw new Error('Payload must be a string or object');
    }

    const jsonBuffer = Buffer.from(jsonStr, 'utf8');

    // 检查负载大小限制
    if (jsonBuffer.length > ATE_FRAME.MAX_JSON_SIZE) {
      throw new Error(`JSON payload size ${jsonBuffer.length} exceeds max ${ATE_FRAME.MAX_JSON_SIZE}`);
    }

    // 分配帧缓冲区
    const frameBuffer = Buffer.alloc(ATE_FRAME.HEADER_SIZE + jsonBuffer.length);

    // 写入 Magic (0x55AA, Big-Endian)
    frameBuffer.writeUInt16BE(ATE_FRAME.MAGIC, 0);

    // 写入 CmdType (Big-Endian)
    frameBuffer.writeUInt16BE(cmdType, 2);

    // 写入 Length (Big-Endian)
    frameBuffer.writeUInt16BE(jsonBuffer.length, 4);

    // 写入 JSON Payload
    jsonBuffer.copy(frameBuffer, ATE_FRAME.HEADER_SIZE);

    this._stats.framesEncoded++;
    return frameBuffer;
  }

  /**
   * 编码下行命令帧
   * @param {string} method - JSON 消息类型 (ATE_METHOD)
   * @param {object} params - 请求参数
   * @param {number} [messageId] - 可选的消息 ID，用于 ACK 匹配
   * @returns {Buffer} 编码后的帧
   */
  encodeDownlink(method, params = {}, messageId = null) {
    const payload = {
      method,
      params,
      ...(messageId !== null && { messageId }),
    };
    return this.encode(ATE_CMD.DOWNLINK, payload);
  }

  /**
   * 编码心跳帧
   * @param {string} deviceId - 设备标识
   * @returns {Buffer} 编码后的帧
   */
  encodeHeartbeat(deviceId) {
    return this.encode(ATE_CMD.HEARTBEAT, {
      method: 'heartbeat',
      deviceId,
      timestamp: Date.now(),
    });
  }

  /**
   * 编码确认应答帧
   * @param {number} messageId - 原始消息 ID
   * @param {boolean} success - 是否成功
   * @param {object} [data] - 附加数据
   * @returns {Buffer} 编码后的帧
   */
  encodeAck(messageId, success, data = {}) {
    const cmdType = success ? ATE_CMD.ACK : ATE_CMD.NACK;
    return this.encode(cmdType, {
      messageId,
      success,
      ...data,
    });
  }

  // ============================================================
  // 解码方法
  // ============================================================

  /**
   * 向解码器喂入数据（流式处理）
   * 处理半包、粘包、多帧连续到达
   * @param {Buffer} data - 接收到的原始数据
   * @returns {Array<object>} 解析出的完整帧数组（可能为空、一个或多个）
   */
  feed(data) {
    // 追加到缓冲区
    this._buffer = Buffer.concat([this._buffer, data]);

    const frames = [];

    // 循环解析，直到缓冲区不足一帧或无完整帧
    while (this._buffer.length >= ATE_FRAME.HEADER_SIZE) {
      // 查找 Magic (0x55AA)
      const magicIndex = this._findMagic();
      if (magicIndex === -1) {
        // 未找到 Magic，丢弃缓冲区所有数据
        this._stats.badMagicDropped += this._buffer.length;
        this._buffer = Buffer.alloc(0);
        break;
      }

      // 如果 Magic 不在缓冲区开头，丢弃 Magic 之前的数据
      if (magicIndex > 0) {
        this._stats.badMagicDropped += magicIndex;
        this._buffer = this._buffer.subarray(magicIndex);
      }

      // 检查是否有足够的帧头
      if (this._buffer.length < ATE_FRAME.HEADER_SIZE) {
        this._stats.incompleteFrames++;
        break;
      }

      // 读取 JSON 长度
      const jsonLength = this._buffer.readUInt16BE(4);

      // 检查长度是否超限
      if (jsonLength > ATE_FRAME.MAX_JSON_SIZE) {
        this._stats.lengthExceeded++;
        // 跳过当前 Magic，继续查找下一个
        this._buffer = this._buffer.subarray(2);
        continue;
      }

      // 检查是否有完整的帧（帧头 + JSON 负载）
      const totalFrameSize = ATE_FRAME.HEADER_SIZE + jsonLength;
      if (this._buffer.length < totalFrameSize) {
        // 半包，等待更多数据
        this._stats.incompleteFrames++;
        break;
      }

      // 提取完整帧
      const frameBuffer = this._buffer.subarray(0, totalFrameSize);
      this._buffer = this._buffer.subarray(totalFrameSize);

      // 解码帧
      const frame = this._decodeFrame(frameBuffer);
      if (frame) {
        frames.push(frame);
      }
    }

    return frames;
  }

  /**
   * 查找 Magic (0x55AA) 在缓冲区中的位置
   * @returns {number} Magic 位置索引，-1 表示未找到
   * @private
   */
  _findMagic() {
    for (let i = 0; i <= this._buffer.length - 2; i++) {
      if (this._buffer[i] === 0x55 && this._buffer[i + 1] === 0xAA) {
        return i;
      }
    }
    return -1;
  }

  /**
   * 解码单个完整帧
   * @param {Buffer} frameBuffer - 完整帧数据
   * @returns {object|null} 解码后的帧对象，JSON 解析失败返回 null
   * @private
   */
  _decodeFrame(frameBuffer) {
    // 读取帧头
    const magic = frameBuffer.readUInt16BE(0);
    const cmdType = frameBuffer.readUInt16BE(2);
    const jsonLength = frameBuffer.readUInt16BE(4);

    // 验证 Magic
    if (magic !== ATE_FRAME.MAGIC) {
      this._stats.badMagicDropped++;
      return null;
    }

    // 提取 JSON Payload
    const jsonBuffer = frameBuffer.subarray(ATE_FRAME.HEADER_SIZE, ATE_FRAME.HEADER_SIZE + jsonLength);
    let payload;

    try {
      payload = JSON.parse(jsonBuffer.toString('utf8'));
    } catch (err) {
      this._stats.jsonParseErrors++;
      return null;
    }

    this._stats.framesDecoded++;

    return {
      magic,
      cmdType,
      jsonLength,
      payload,
      raw: frameBuffer,
    };
  }

  /**
   * 清空接收缓冲区
   */
  clearBuffer() {
    this._buffer = Buffer.alloc(0);
  }

  /**
   * 获取当前缓冲区大小
   */
  getBufferSize() {
    return this._buffer.length;
  }
}

module.exports = AteFrameCodec;
