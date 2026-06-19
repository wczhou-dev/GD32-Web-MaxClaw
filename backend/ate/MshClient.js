/**
 * backend/ate/MshClient.js
 * MSH (Modbus Shell) 调试串口客户端
 *
 * 职责：
 *   1. 连接环控器调试串口 (COM4, 115200 baud)
 *   2. 发送 MSH 命令并解析响应
 *   3. 读取历史缓冲 (sensor_history)
 *   4. 清空历史缓冲 (sensor_history_clear)
 *   5. 连接状态管理与超时处理
 *
 * 更新历史：
 *   v1.0  2026-06-20  初始版本
 */

'use strict';

const { EventEmitter } = require('events');

class MshClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.port='COM4'] - 调试串口号
   * @param {number} [options.baudRate=115200] - 波特率
   * @param {number} [options.commandTimeoutMs=5000] - 命令响应超时
   */
  constructor(options = {}) {
    super();
    this._portPath = options.port || 'COM4';
    this._baudRate = options.baudRate || 115200;
    this._commandTimeoutMs = options.commandTimeoutMs || 5000;
    this._serialPort = null;
    this._connected = false;
    this._rxBuffer = '';
    this._pendingCommand = null;  // { resolve, reject, timer, buffer }
  }

  /**
   * 连接调试串口
   */
  async connect() {
    if (this._connected) return;

    try {
      const { SerialPort } = require('serialport');
      this._serialPort = new SerialPort({
        path: this._portPath,
        baudRate: this._baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
      });

      return new Promise((resolve, reject) => {
        const onError = (err) => {
          this._serialPort.removeListener('open', onOpen);
          reject(new Error(`MSH 串口打开失败 (${this._portPath}): ${err.message}`));
        };
        const onOpen = () => {
          this._serialPort.removeListener('error', onError);
          this._connected = true;
          this._serialPort.on('data', this._onData.bind(this));
          this._serialPort.on('error', (err) => this.emit('error', err));
          this._serialPort.on('close', () => {
            this._connected = false;
            this.emit('disconnected');
          });
          this.emit('connected', { port: this._portPath, baudRate: this._baudRate });
          resolve();
        };

        this._serialPort.once('open', onOpen);
        this._serialPort.once('error', onError);
      });
    } catch (err) {
      throw new Error(`MSH 串口初始化失败: ${err.message}`);
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    if (this._serialPort && this._connected) {
      return new Promise((resolve) => {
        this._serialPort.close(() => {
          this._connected = false;
          resolve();
        });
      });
    }
  }

  /**
   * 发送 MSH 命令并等待响应
   * @param {string} command - MSH 命令 (如 'sensor_history')
   * @param {number} [timeoutMs] - 超时时间
   * @returns {Promise<string>} 响应文本
   */
  async sendCommand(command, timeoutMs) {
    if (!this._connected) {
      await this.connect();
    }

    const timeout = timeoutMs || this._commandTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCommand = null;
        reject(new Error(`MSH 命令超时 (${command}, ${timeout}ms): ${buffer}`));
      }, timeout);

      const buffer = '';
      this._pendingCommand = {
        resolve: (text) => {
          clearTimeout(timer);
          this._pendingCommand = null;
          resolve(text);
        },
        reject: (err) => {
          clearTimeout(timer);
          this._pendingCommand = null;
          reject(err);
        },
        timer,
        buffer: '',
        command,
      };

      // 发送命令 (加换行)
      const cmd = command.trim() + '\r\n';
      this._serialPort.write(cmd, (err) => {
        if (err) {
          clearTimeout(timer);
          this._pendingCommand = null;
          reject(new Error(`MSH 命令发送失败: ${err.message}`));
        }
      });
    });
  }

  /**
   * 串口数据接收处理
   */
  _onData(data) {
    const text = data.toString('utf8');
    if (!this._pendingCommand) return;

    this._pendingCommand.buffer += text;

    // 检测 MSH 提示符 (msh />) 表示命令完成
    if (this._pendingCommand.buffer.includes('msh />') ||
        this._pendingCommand.buffer.includes('msh>')) {
      this._pendingCommand.resolve(this._pendingCommand.buffer);
    }
  }

  /**
   * 读取历史缓冲
   * @returns {Promise<Array<{tm_hour: number, temp: number, humi: number, timestamp: number}>>}
   */
  async readHistory() {
    const response = await this.sendCommand('sensor_history', 8000);
    return this._parseHistory(response);
  }

  /**
   * 清空历史缓冲
   * @returns {Promise<boolean>} 是否成功
   */
  async clearHistory() {
    try {
      await this.sendCommand('sensor_history_clear', 5000);
      return true;
    } catch (e) {
      // sensor_history_clear 可能未实现，返回 false 而非抛异常
      return false;
    }
  }

  /**
   * 测试 MSH 是否可用
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      const response = await this.sendCommand('help', 3000);
      return response.includes('msh');
    } catch (_) {
      return false;
    }
  }

  /**
   * 解析 sensor_history 输出
   * 支持多种可能的固件输出格式：
   *   格式1: idx=0 hour=11 temp=20.0 humi=60.0 stamp=123456
   *   格式2: [0] hour=11 temp=20.0 humi=60.0
   *   格式3: 11  20.0  60.0  123456 (空格分隔)
   */
  _parseHistory(text) {
    const entries = [];

    // 正则：匹配 hour=N temp=N humi=N 模式
    const hourTempHumiRegex = /hour\s*=\s*(\d+)[\s,;|]+temp\s*=\s*(-?[\d.]+)[\s,;|]+humi\s*=\s*(-?[\d.]+)/gi;

    let match;
    while ((match = hourTempHumiRegex.exec(text)) !== null) {
      entries.push({
        tm_hour: parseInt(match[1], 10),
        temp: parseFloat(match[2]),
        humi: parseFloat(match[3]),
      });
    }

    // 备选格式：尝试按行解析 tab/空格分隔
    if (entries.length === 0) {
      const lines = text.split('\n');
      for (const line of lines) {
        // 跳过提示符和空行
        if (line.includes('msh') || line.includes('sensor') || !line.trim()) continue;

        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const hour = parseInt(parts[0], 10);
          const temp = parseFloat(parts[1]);
          const humi = parseFloat(parts[2]);
          if (!isNaN(hour) && hour >= 0 && hour <= 23 && !isNaN(temp) && !isNaN(humi)) {
            entries.push({ tm_hour: hour, temp, humi });
          }
        }
      }
    }

    return entries;
  }
}

module.exports = MshClient;
