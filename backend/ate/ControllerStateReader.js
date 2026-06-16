/**
 * backend/ate/ControllerStateReader.js
 * 环控器状态读取器
 *
 * 职责：
 *   1. 封装 Modbus TCP 读写操作，提供结构化接口
 *   2. 读取场区类型、安装状态、传感器数据、告警、历史缓冲
 *   3. 写入配置（阈值/补偿/安装位）、对时、重启
 *   4. 所有操作通过 DevicePool.runExclusive() 串行化
 *
 * 开发依据：
 *   - 传感器自动测试内容开发清单P1.md §2.0~2.2, §9.3
 *   - 传感器自动测试任务开发列表P1.md §六
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本
 */

'use strict';

const {
  BLOCK_ENV,
  BLOCK_SENSOR_CONFIG,
  SENSOR_ACTUAL,
  BLOCK_SENSOR_TIME,
  BLOCK_HW,
  INVALID_VALUE,
} = require('../../shared/constants');

class ControllerStateReader {
  /**
   * @param {object} options
   * @param {DevicePool} options.devicePool - 设备连接池
   * @param {string} options.deviceKey - 设备键 (ip:port:unitId)
   */
  constructor(options = {}) {
    this._devicePool = options.devicePool;
    this._deviceKey = options.deviceKey;
  }

  /**
   * 更新设备键
   * @param {string} deviceKey
   */
  setDeviceKey(deviceKey) {
    this._deviceKey = deviceKey;
  }

  // ============================================================
  // 基础读取
  // ============================================================

  /**
   * 读取场区类型
   * @returns {Promise<number>} 0=未配置, 1=A, 2=B, 3=C
   */
  async readFieldZone() {
    const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.readHoldingRegisters(
        this._deviceKey, BLOCK_SENSOR_CONFIG.FIELD_ZONE_TYPE, 1
      );
    });
    return result.data[0];
  }

  /**
   * 读取传感器安装状态
   * @returns {Promise<object>} { temp[16], humi[16], co2[8], nh3[4], press[4], outdoor[5] }
   */
  async readInstallStatus() {
    const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.readHoldingRegisters(
        this._deviceKey, BLOCK_SENSOR_CONFIG.INSTALL_TEMP, 6
      );
    });
    const data = result.data;

    return {
      temp:    Array.from({ length: 16 }, (_, i) => Boolean((data[0] >> i) & 1)),
      humi:    Array.from({ length: 16 }, (_, i) => Boolean((data[1] >> i) & 1)),
      co2:     Array.from({ length: 8 },  (_, i) => Boolean((data[2] >> i) & 1)),
      nh3:     Array.from({ length: 4 },  (_, i) => Boolean((data[3] >> i) & 1)),
      press:   Array.from({ length: 4 },  (_, i) => Boolean((data[4] >> i) & 1)),
      outdoor: Array.from({ length: 5 },  (_, i) => Boolean((data[5] >> i) & 1)),
    };
  }

  /**
   * 读取传感器数据（BLOCK_ENV 全块）
   * @returns {Promise<object>} 结构化传感器数据
   */
  async readSensorData() {
    const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.readHoldingRegisters(
        this._deviceKey, BLOCK_ENV.START, 72  // 0x1001~0x1048
      );
    });
    const raw = result.data;

    // 温度：0x1001 + i*2 (i=0..15)，int16, val/10
    const temp = Array.from({ length: 16 }, (_, i) => {
      const val = raw[i * 2];
      const signed = val > 32767 ? val - 65536 : val;
      return signed / 10;
    });

    // 湿度：0x1002 + i*2 (i=0..15)，uint16, val/10
    const humi = Array.from({ length: 16 }, (_, i) => raw[i * 2 + 1] / 10);

    // CO2：0x1021 + i (i=0..7)，uint16, 原值
    // 0x1021 - 0x1001 = 0x20 = 32，偏移 32 个寄存器
    const co2 = Array.from({ length: 8 }, (_, i) => raw[32 + i]);

    // 压差：0x1042 + i (i=0..3)，int16, val/10
    // 0x1042 - 0x1001 = 0x41 = 65，偏移 65 个寄存器
    const press = Array.from({ length: 4 }, (_, i) => {
      const val = raw[65 + i];
      const signed = val > 32767 ? val - 65536 : val;
      return signed / 10;
    });

    // 舍外温度：0x1039 (偏移 56), 舍外湿度：0x103A (偏移 57)
    const outdoorTemp = raw[56] > 32767 ? (raw[56] - 65536) / 10 : raw[56] / 10;
    const outdoorHumi = raw[57] / 10;

    return {
      temp,
      humi,
      co2,
      press,
      outdoorTemp,
      outdoorHumi,
      raw,
    };
  }

  /**
   * 读取 ActualTemp/ActualHumi
   * @returns {Promise<{actualTemp: number, actualHumi: number, actualTempRaw: number, actualHumiRaw: number}>}
   */
  async readActualTempHumi() {
    const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.readHoldingRegisters(
        this._deviceKey, SENSOR_ACTUAL.ACTUAL_TEMP, 2
      );
    });
    const rawTemp = result.data[0];
    const rawHumi = result.data[1];

    const actualTemp = (rawTemp > 32767 ? rawTemp - 65536 : rawTemp) / 10;
    const actualHumi = rawHumi / 10;

    return {
      actualTemp,
      actualHumi,
      actualTempRaw: rawTemp,
      actualHumiRaw: rawHumi,
      tempInvalid: rawTemp === INVALID_VALUE,
      humiInvalid: rawHumi === INVALID_VALUE,
    };
  }

  /**
   * 读取单个寄存器
   * @param {number} address
   * @returns {Promise<number>}
   */
  async readRegister(address) {
    const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.readHoldingRegisters(this._deviceKey, address, 1);
    });
    return result.data[0];
  }

  /**
   * 批量读取寄存器
   * @param {number} address
   * @param {number} count
   * @returns {Promise<number[]>}
   */
  async readRegisters(address, count) {
    const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.readHoldingRegisters(this._deviceKey, address, count);
    });
    return result.data;
  }

  // ============================================================
  // 配置写入
  // ============================================================

  /**
   * 写入单个寄存器
   * @param {number} address
   * @param {number} value
   */
  async writeRegister(address, value) {
    await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.writeRegister(this._deviceKey, address, value);
    });
  }

  /**
   * 批量写入寄存器
   * @param {number} address
   * @param {number[]} values
   */
  async writeRegisters(address, values) {
    await this._devicePool.runExclusive(this._deviceKey, async () => {
      return await this._devicePool.writeRegisters(this._deviceKey, address, values);
    });
  }

  /**
   * 写入安装状态位
   * @param {string} sensorType 'temp'|'humi'|'co2'|'nh3'|'press'|'outdoor'
   * @param {number} bitIndex 0-based 位位置
   * @param {boolean} enabled 是否启用
   */
  async writeInstallBit(sensorType, bitIndex, enabled) {
    const regMap = {
      temp: BLOCK_SENSOR_CONFIG.INSTALL_TEMP,
      humi: BLOCK_SENSOR_CONFIG.INSTALL_HUMI,
      co2: BLOCK_SENSOR_CONFIG.INSTALL_CO2,
      nh3: BLOCK_SENSOR_CONFIG.INSTALL_NH3,
      press: BLOCK_SENSOR_CONFIG.INSTALL_PRESS,
      outdoor: BLOCK_SENSOR_CONFIG.INSTALL_OUTDOOR,
    };
    const address = regMap[sensorType];
    if (!address) throw new Error(`未知传感器类型: ${sensorType}`);

    const current = await this.readRegister(address);
    let newValue;
    if (enabled) {
      newValue = current | (1 << bitIndex);
    } else {
      newValue = current & ~(1 << bitIndex);
    }
    await this.writeRegister(address, newValue);
    return newValue;
  }

  // ============================================================
  // 对时与重启
  // ============================================================

  /**
   * 对时
   * @param {object} time { year, month, day, hour, minute, second }
   * @returns {Promise<{ok: boolean, targetTime: string, deviceTime: string}>}
   */
  async syncTime(time) {
    const { year, month, day, hour, minute, second } = time;

    // 写入 HR10~HR15
    await this.writeRegisters(BLOCK_SENSOR_TIME.TIME_YEAR, [
      year, month, day, hour, minute, second
    ]);

    // 写入 HR16=1 触发对时
    await this.writeRegister(BLOCK_SENSOR_TIME.TIME_TRIGGER, 1);

    // 等待对时完成（轮询 HR17）
    let hr17 = 1;
    for (let i = 0; i < 20; i++) {
      await this._sleep(500);
      hr17 = await this.readRegister(BLOCK_SENSOR_TIME.TIME_RESULT);
      if (hr17 === 0) break;
    }

    // 读回设备时间确认
    const devTime = await this.readRegisters(BLOCK_SENSOR_TIME.TIME_YEAR, 6);

    const targetStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    const devStr = `${devTime[0]}-${String(devTime[1]).padStart(2, '0')}-${String(devTime[2]).padStart(2, '0')} ${String(devTime[3]).padStart(2, '0')}:${String(devTime[4]).padStart(2, '0')}:${String(devTime[5]).padStart(2, '0')}`;

    return {
      ok: hr17 === 0 && devTime[3] === hour && devTime[4] === minute,
      hr17,
      targetTime: targetStr,
      deviceTime: devStr,
      deviceTimeArray: devTime,
    };
  }

  /**
   * 重启设备
   * @param {object} [options]
   * @param {number} [options.waitMs=60000] 等待重启时间
   * @param {number} [options.retryIntervalMs=3000] 重试间隔
   * @returns {Promise<{ok: boolean, rebootTimeMs: number}>}
   */
  async reboot(options = {}) {
    const { waitMs = 60000, retryIntervalMs = 3000 } = options;
    const startTime = Date.now();

    // 写入 HR18 = 0x55AA
    await this.writeRegister(BLOCK_SENSOR_TIME.REBOOT, BLOCK_SENSOR_TIME.REBOOT_MAGIC);
    console.log('[ControllerStateReader] 重启指令已发送 (HR18 = 0x55AA)');

    // 断开当前连接
    try {
      await this._devicePool.disconnect(this._deviceKey);
    } catch (e) {
      // 忽略断开错误
    }

    // 等待设备重启并重连
    await this._sleep(waitMs);

    // 尝试重连
    let reconnected = false;
    const maxRetries = Math.ceil(waitMs / retryIntervalMs);
    for (let i = 0; i < maxRetries; i++) {
      try {
        const connected = await this._devicePool.connect(this._deviceKey);
        if (connected) {
          // 验证设备可用
          await this.readRegister(BLOCK_SENSOR_TIME.TIME_HOUR);
          reconnected = true;
          break;
        }
      } catch (e) {
        console.log(`[ControllerStateReader] 重连尝试 ${i + 1}/${maxRetries} 失败: ${e.message}`);
      }
      await this._sleep(retryIntervalMs);
    }

    const elapsed = Date.now() - startTime;
    return {
      ok: reconnected,
      rebootTimeMs: elapsed,
    };
  }

  /**
   * 恢复真实时间（对时到当前系统时间）
   * @returns {Promise<object>}
   */
  async restoreRealTime() {
    const now = new Date();
    return await this.syncTime({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
    });
  }

  // ============================================================
  // 历史缓冲（需要固件配合）
  // ============================================================

  /**
   * 读取历史缓冲最近 N 条
   * 注意：需要固件提供读取接口（Modbus 调试寄存器 / MSH / 测试 API）
   * @param {number} count
   * @returns {Promise<Array<{tm_hour: number, temp: number, humi: number, timestamp: number}>>}
   */
  async readHistoryTail(count) {
    // TODO: 接入固件侧历史缓冲读取接口
    // 方案 1: Modbus 调试寄存器（推荐）
    // 方案 2: 通过 ATE TCP 发送 MSH 命令并解析输出
    // 方案 3: 测试专用 API
    throw new Error('readHistoryTail 未实现：需要固件提供历史缓冲读取接口');
  }

  /**
   * 清空历史缓冲
   * @returns {Promise<boolean>}
   */
  async clearHistory() {
    // TODO: 接入固件侧清空接口
    // 方案 1: MSH sensor_history_clear
    // 方案 2: Modbus 调试寄存器触发
    throw new Error('clearHistory 未实现：需要固件提供历史缓冲清空接口');
  }

  // ============================================================
  // 告警读取
  // ============================================================

  /**
   * 读取告警状态
   * @returns {Promise<object>}
   */
  async readAlarmStatus() {
    // TODO: 确认告警寄存器地址后实现
    // 暂时返回占位
    return {
      erRead: false,
      erMax: false,
      tempHigh: false,
      humiHigh: false,
    };
  }

  // ============================================================
  // 工具方法
  // ============================================================

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ControllerStateReader;
