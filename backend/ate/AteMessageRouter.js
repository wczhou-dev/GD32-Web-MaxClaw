/**
 * backend/ate/AteMessageRouter.js
 * ATE 消息路由器
 *
 * 职责：
 *   1. 关联请求与 ACK（通过 messageId）
 *   2. 路由 report 走事件流
 *   3. 路由 properties.reply 走响应流
 *   4. 管理并发请求，防止不同 functionId 串包
 *
 * 开发依据：
 *   - P0 方案第 4 章：TCP+JSON ATE 协议规范
 *   - shared/constants.js：ATE_CMD, ATE_METHOD
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，基础消息路由
 */

'use strict';

const EventEmitter = require('events');
const { ATE_CMD, ATE_METHOD } = require('../../shared/constants');

/**
 * ATE 消息路由器
 * 协调 AteTcpClient 与上层业务模块的消息传递
 */
class AteMessageRouter extends EventEmitter {
  constructor() {
    super();

    /**
     * 消息处理器注册表：method -> handler
     */
    this._handlers = new Map();

    /**
     * report 事件订阅者列表
     */
    this._reportSubscribers = [];

    /**
     * 统计信息
     */
    this._stats = {
      messagesRouted: 0,
      reportsRouted: 0,
      errorsHandled: 0,
      unknownMethods: 0,
    };
  }

  // ============================================================
  // 公共方法
  // ============================================================

  /**
   * 注册消息处理器
   * @param {string} method - 消息方法 (ATE_METHOD)
   * @param {Function} handler - 处理函数 (payload, context) => Promise<object>
   */
  registerHandler(method, handler) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }
    this._handlers.set(method, handler);
  }

  /**
   * 注销消息处理器
   * @param {string} method
   */
  unregisterHandler(method) {
    this._handlers.delete(method);
  }

  /**
   * 订阅 report 事件
   * @param {Function} callback - 回调函数 (report) => void
   * @returns {Function} 取消订阅函数
   */
  subscribeReport(callback) {
    this._reportSubscribers.push(callback);
    return () => {
      this._reportSubscribers = this._reportSubscribers.filter(cb => cb !== callback);
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this._stats };
  }

  // ============================================================
  // 消息处理
  // ============================================================

  /**
   * 处理来自 AteTcpClient 的帧
   * @param {object} frame - 解码后的帧对象
   * @param {object} context - 上下文信息（如 deviceIp, sessionId）
   * @returns {Promise<object|null>} 处理结果
   */
  async handleFrame(frame, context = {}) {
    const { cmdType, payload } = frame;

    this._stats.messagesRouted++;

    switch (cmdType) {
      case ATE_CMD.REPORT:
        return this._handleReport(payload, context);

      case ATE_CMD.ERROR:
        return this._handleError(payload, context);

      case ATE_CMD.ACK:
      case ATE_CMD.NACK:
        // ACK/NACK 由 AteTcpClient 直接处理，路由器不重复处理
        return null;

      default:
        this._stats.unknownMethods++;
        this.emit('unknown_frame', { frame, context });
        return null;
    }
  }

  /**
   * 处理下行请求的响应
   * @param {object} response - ACK/NACK 响应
   * @param {object} request - 原始请求信息
   * @returns {Promise<object|null>}
   */
  async handleResponse(response, request = {}) {
    const { method } = request;

    if (method && this._handlers.has(method)) {
      try {
        const handler = this._handlers.get(method);
        return await handler(response, { ...request, isResponse: true });
      } catch (err) {
        this.emit('handler_error', { method, error: err });
        return null;
      }
    }

    return response;
  }

  /**
   * 发送请求并等待响应（通过 AteTcpClient）
   * @param {object} client - AteTcpClient 实例
   * @param {string} method - 请求方法
   * @param {object} params - 请求参数
   * @param {object} context - 上下文信息
   * @returns {Promise<object>}
   */
  async request(client, method, params = {}, context = {}) {
    if (!client.isConnected()) {
      throw new Error('客户端未连接');
    }

    // 执行请求
    const response = await client.request(method, params);

    // 路由响应到处理器
    await this.handleResponse(response, { method, params, ...context });

    return response;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 处理 report 上报
   * @param {object} payload
   * @param {object} context
   * @returns {object}
   * @private
   */
  _handleReport(payload, context) {
    this._stats.reportsRouted++;

    // 通知所有订阅者
    const report = {
      deviceIp: context.deviceIp,
      timestamp: Date.now(),
      ...payload,
    };

    for (const subscriber of this._reportSubscribers) {
      try {
        subscriber(report);
      } catch (err) {
        this.emit('subscriber_error', { error: err });
      }
    }

    this.emit('report', report);
    return report;
  }

  /**
   * 处理错误响应
   * @param {object} payload
   * @param {object} context
   * @returns {object}
   * @private
   */
  _handleError(payload, context) {
    this._stats.errorsHandled++;

    const error = {
      deviceIp: context.deviceIp,
      timestamp: Date.now(),
      ...payload,
    };

    this.emit('device_error', error);
    return error;
  }
}

module.exports = AteMessageRouter;
