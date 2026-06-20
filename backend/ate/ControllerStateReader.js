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
   * 对时（带重连保护）
   * 固件处理对时可能关闭 TCP 连接，需在轮询 HR17 时处理断连重连
   */
  async syncTime(time) {
    const { year, month, day, hour, minute, second } = time;

    // 写入 HR10~HR15 和 HR16=1（触发对时），在同一个 runExclusive 中完成
    // 避免中间断连导致部分写入
    try {
      await this._devicePool.runExclusive(this._deviceKey, async () => {
        await this._devicePool.writeRegisters(this._deviceKey, BLOCK_SENSOR_TIME.TIME_YEAR, [
          year, month, day, hour, minute, second
        ]);
        await this._devicePool.writeRegister(this._deviceKey, BLOCK_SENSOR_TIME.TIME_TRIGGER, 1);
      });
    } catch (err) {
      console.warn(`[ControllerStateReader] syncTime 写入失败: ${err.message}，尝试重连...`);
      await this._ensureConnected();
      // 重试写入
      await this._devicePool.runExclusive(this._deviceKey, async () => {
        await this._devicePool.writeRegisters(this._deviceKey, BLOCK_SENSOR_TIME.TIME_YEAR, [
          year, month, day, hour, minute, second
        ]);
        await this._devicePool.writeRegister(this._deviceKey, BLOCK_SENSOR_TIME.TIME_TRIGGER, 1);
      });
    }

    // 等待对时完成（轮询 HR17），带重连保护
    let hr17 = 1;
    for (let i = 0; i < 30; i++) {
      await this._sleep(500);
      try {
        hr17 = await this.readRegister(BLOCK_SENSOR_TIME.TIME_RESULT);
        if (hr17 === 0) break;
      } catch (err) {
        console.warn(`[ControllerStateReader] HR17 轮询失败 (attempt ${i+1}): ${err.message}`);
        // 尝试重连
        await this._ensureConnected();
      }
    }

    // 读回设备时间确认（带重连保护）
    let devTime;
    try {
      devTime = await this.readRegisters(BLOCK_SENSOR_TIME.TIME_YEAR, 6);
    } catch (err) {
      console.warn(`[ControllerStateReader] 读取设备时间失败: ${err.message}，尝试重连...`);
      await this._ensureConnected();
      devTime = await this.readRegisters(BLOCK_SENSOR_TIME.TIME_YEAR, 6);
    }

    const targetStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    const devStr = `${devTime[0]}-${String(devTime[1]).padStart(2, '0')}-${String(devTime[2]).padStart(2, '0')} ${String(devTime[3]).padStart(2, '0')}:${String(devTime[4]).padStart(2, '0')}:${String(devTime[5]).padStart(2, '0')}`;

    return {
      ok: hr17 === 0 && devTime[3] === hour && devTime[4] === minute,
      hr17,
      targetTime: targetStr,
      deviceTime: devStr,
      deviceTimeArray: devTime,
      // 记录对时完成时刻的系统时间戳，供 _waitCrossHour 推算固件时钟
      syncCompletedAt: Date.now(),
      syncMinute: minute,
      syncSecond: second,
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
  // 历史缓冲
  // ============================================================

  /**
   * 读取历史缓冲最近 N 条
   * 实现方案：Modbus TCP 调试寄存器（推荐方案）
   *
   * 寄存器约定（需固件配合实现）：
   *   - 0x7100: 历史缓冲条目总数 (HISTORY_LOG_MAX=25)
   *   - 0x7101: 最新条目索引
   *   - 0x7102: 读取触发寄存器（写入索引号触发读取）
   *   - 0x7103: 读取结果 - tm_hour
   *   - 0x7104: 读取结果 - temp 原始值 (int16, val/10)
   *   - 0x7105: 读取结果 - humi 原始值 (uint16, val/10)
   *   - 0x7106: 读取结果 - timestamp 高 16 位
   *   - 0x7107: 读取结果 - timestamp 低 16 位
   *
   * @param {number} count 读取最近 N 条
   * @returns {Promise<Array<{tm_hour: number, temp: number, humi: number, timestamp: number}>>}
   */
  async readHistoryTail(count) {
    const HISTORY_TOTAL_REG = 0x7100;
    const HISTORY_LATEST_REG = 0x7101;
    const HISTORY_READ_TRIGGER = 0x7102;
    const HISTORY_RESULT_HOUR = 0x7103;
    const HISTORY_RESULT_TEMP = 0x7104;
    const HISTORY_RESULT_HUMI = 0x7105;
    const HISTORY_RESULT_TS_H = 0x7106;
    const HISTORY_RESULT_TS_L = 0x7107;

    try {
      // 读取最新条目索引
      const latestResult = await this._devicePool.runExclusive(this._deviceKey, async () => {
        return await this._devicePool.readHoldingRegisters(
          this._deviceKey, HISTORY_TOTAL_REG, 2
        );
      });
      const total = latestResult.data[0];
      const latestIdx = latestResult.data[1];

      if (total === 0 || latestIdx === 0) {
        return [];
      }

      const entries = [];
      for (let i = 0; i < count; i++) {
        const idx = (latestIdx - i + total) % total;
        if (idx < 0) break;

        // 触发读取指定索引
        await this._devicePool.runExclusive(this._deviceKey, async () => {
          await this._devicePool.writeRegister(this._deviceKey, HISTORY_READ_TRIGGER, idx);
        });

        // 等待固件准备数据
        await this._sleep(50);

        // 读取结果
        const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
          return await this._devicePool.readHoldingRegisters(
            this._deviceKey, HISTORY_RESULT_HOUR, 5
          );
        });

        const tm_hour = result.data[0];
        const tempRaw = result.data[1];
        const humiRaw = result.data[2];
        const tsHigh = result.data[3];
        const tsLow = result.data[4];

        const temp = (tempRaw > 32767 ? tempRaw - 65536 : tempRaw) / 10;
        const humi = humiRaw / 10;
        const timestamp = (tsHigh << 16) | tsLow;

        entries.push({ index: idx, tm_hour, temp, humi, timestamp });
      }

      return entries.reverse();  // 按时间从旧到新
    } catch (err) {
      console.warn(`[ControllerStateReader] readHistoryTail 失败: ${err.message}`);
      throw new Error(`readHistoryTail 失败: ${err.message}。确认固件已实现 0x7100~0x7107 调试寄存器`);
    }
  }

  /**
   * 清空历史缓冲
   * 实现方案：Modbus TCP 调试寄存器
   *
   * 寄存器约定（需固件配合实现）：
   *   - 0x7110: 清空触发寄存器（写 0xAA55 触发清空）
   *   - 0x7111: 清空结果（0=成功, 非0=失败）
   *
   * @returns {Promise<boolean>}
   */
  async clearHistory() {
    const HISTORY_CLEAR_TRIGGER = 0x7110;
    const HISTORY_CLEAR_RESULT = 0x7111;
    const HISTORY_CLEAR_MAGIC = 0xAA55;

    try {
      // 写入清空魔数
      await this._devicePool.runExclusive(this._deviceKey, async () => {
        await this._devicePool.writeRegister(this._deviceKey, HISTORY_CLEAR_TRIGGER, HISTORY_CLEAR_MAGIC);
      });

      // 等待清空完成
      await this._sleep(200);

      // 读取结果
      const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
        return await this._devicePool.readHoldingRegisters(
          this._deviceKey, HISTORY_CLEAR_RESULT, 1
        );
      });

      if (result.data[0] !== 0) {
        throw new Error(`清空返回错误码: ${result.data[0]}`);
      }

      console.log('[ControllerStateReader] 历史缓冲已清空');
      return true;
    } catch (err) {
      console.warn(`[ControllerStateReader] clearHistory 失败: ${err.message}`);
      throw new Error(`clearHistory 失败: ${err.message}。确认固件已实现 0x7110~0x7111 调试寄存器`);
    }
  }

  // ============================================================
  // 告警读取
  // ============================================================

  /**
   * 读取告警状态
   * @returns {Promise<object>}
   */
  async readAlarmStatus() {
    const {
      BLOCK_SENSOR_ALARM,
    } = require('../../shared/constants');

    try {
      const result = await this._devicePool.runExclusive(this._deviceKey, async () => {
        return await this._devicePool.readHoldingRegisters(
          this._deviceKey, BLOCK_SENSOR_ALARM.ER_READ_FLAG, 5
        );
      });

      return {
        erRead: result.data[0] !== 0,
        erMax: result.data[1] !== 0,
        tempHigh: result.data[2] !== 0,
        humiHigh: result.data[3] !== 0,
        onlineStatus: result.data[4],
        raw: result.data,
      };
    } catch (err) {
      console.warn(`[ControllerStateReader] readAlarmStatus 失败: ${err.message}`);
      return {
        erRead: false,
        erMax: false,
        tempHigh: false,
        humiHigh: false,
        onlineStatus: 0,
        raw: [0, 0, 0, 0, 0],
      };
    }
  }

  /**
   * 读取端口配置
   * @param {number} sensorIndex 传感器路数 (0-based)
   * @returns {Promise<number>} 端口号
   */
  async readPortConfig(sensorIndex) {
    const PORT_CONFIG_BASE = 0x7070;  // 端口配置基址
    const address = PORT_CONFIG_BASE + sensorIndex;
    return await this.readRegister(address);
  }

  /**
   * 写入端口配置
   * @param {number} sensorIndex 传感器路数 (0-based)
   * @param {number} port 端口号
   */
  async writePortConfig(sensorIndex, port) {
    const PORT_CONFIG_BASE = 0x7070;
    const address = PORT_CONFIG_BASE + sensorIndex;
    await this.writeRegister(address, port);
  }

  /**
   * 读取阈值配置
   * @param {string} type 'temp_high'|'temp_low'|'humi_high'|'humi_low'
   * @returns {Promise<number>} 阈值原始值 (val/10 为工程值)
   */
  async readThreshold(type) {
    const {
      BLOCK_SENSOR_THRESHOLD,
    } = require('../../shared/constants');
    const regMap = {
      temp_high: BLOCK_SENSOR_THRESHOLD.TEMP_HIGH_LIMIT,
      temp_low: BLOCK_SENSOR_THRESHOLD.TEMP_LOW_LIMIT,
      humi_high: BLOCK_SENSOR_THRESHOLD.HUMI_HIGH_LIMIT,
      humi_low: BLOCK_SENSOR_THRESHOLD.HUMI_LOW_LIMIT,
    };
    const address = regMap[type];
    if (!address) throw new Error(`未知阈值类型: ${type}`);
    return await this.readRegister(address);
  }

  /**
   * 写入阈值配置
   * @param {string} type
   * @param {number} value 原始值 (val/10 为工程值)
   */
  async writeThreshold(type, value) {
    const {
      BLOCK_SENSOR_THRESHOLD,
    } = require('../../shared/constants');
    const regMap = {
      temp_high: BLOCK_SENSOR_THRESHOLD.TEMP_HIGH_LIMIT,
      temp_low: BLOCK_SENSOR_THRESHOLD.TEMP_LOW_LIMIT,
      humi_high: BLOCK_SENSOR_THRESHOLD.HUMI_HIGH_LIMIT,
      humi_low: BLOCK_SENSOR_THRESHOLD.HUMI_LOW_LIMIT,
    };
    const address = regMap[type];
    if (!address) throw new Error(`未知阈值类型: ${type}`);
    await this.writeRegister(address, value);
  }

  /**
   * 写入补偿值
   * @param {string} sensorType 'temp'|'humi'
   * @param {number} index 传感器路数 (0-based)
   * @param {number} value 补偿值原始值 (val/10 为工程值)
   */
  async writeCompensation(sensorType, index, value) {
    const {
      BLOCK_SENSOR_COMPENSATION,
    } = require('../../shared/constants');
    const base = sensorType === 'temp'
      ? BLOCK_SENSOR_COMPENSATION.TEMP_COMP_BASE
      : BLOCK_SENSOR_COMPENSATION.HUMI_COMP_BASE;
    await this.writeRegister(base + index, value);
  }

  /**
   * 读取补偿值
   * @param {string} sensorType 'temp'|'humi'
   * @param {number} index 传感器路数 (0-based)
   * @returns {Promise<number>}
   */
  async readCompensation(sensorType, index) {
    const {
      BLOCK_SENSOR_COMPENSATION,
    } = require('../../shared/constants');
    const base = sensorType === 'temp'
      ? BLOCK_SENSOR_COMPENSATION.TEMP_COMP_BASE
      : BLOCK_SENSOR_COMPENSATION.HUMI_COMP_BASE;
    return await this.readRegister(base + index);
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 确保设备已连接（带重连逻辑）
   * 用于对时/重启等可能导致 TCP 断连的操作后恢复连接
   */
  async _ensureConnected() {
    const MAX_RETRIES = 5;
    const RETRY_INTERVAL = 3000;
    const COOLDOWN_WAIT = 13000;  // DevicePool 冷却期约 12 秒

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        // 先检查是否在冷却期
        const cooldownRemaining = this._devicePool.getCooldownRemaining
          ? this._devicePool.getCooldownRemaining(this._deviceKey) : 0;
        if (cooldownRemaining > 0) {
          console.log(`[ControllerStateReader] 等待冷却期结束 (${cooldownRemaining}ms)...`);
          await this._sleep(cooldownRemaining + 500);
        }

        const connected = await this._devicePool.connect(this._deviceKey);
        if (connected) {
          // 验证连接可用
          await this.readRegister(BLOCK_SENSOR_TIME.TIME_HOUR);
          console.log(`[ControllerStateReader] 重连成功 (attempt ${i+1})`);
          return;
        }
      } catch (err) {
        console.warn(`[ControllerStateReader] 重连失败 (attempt ${i+1}/${MAX_RETRIES}): ${err.message}`);
      }
      await this._sleep(RETRY_INTERVAL);
    }
    console.warn(`[ControllerStateReader] 重连 ${MAX_RETRIES} 次后放弃`);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ControllerStateReader;
