/**
 * backend/ate/MockControllerStateReader.js
 * Mock 环控器状态读取器
 *
 * 职责：
 *   1. 在无硬件时模拟 ControllerStateReader 的行为
 *   2. 直接从 SensorSimulator 的影子寄存器读取数据
 *   3. 模拟对时、重启等操作
 *
 * 使用场景：
 *   - Mock 自测：验证场景编排、断言、报告逻辑
 *   - 开发调试：无需环控器和 USB-RS485
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本
 */

'use strict';

const {
  BLOCK_SENSOR_CONFIG,
  SENSOR_ACTUAL,
  BLOCK_SENSOR_TIME,
  BLOCK_SENSOR_ALARM,
  BLOCK_SENSOR_THRESHOLD,
  BLOCK_SENSOR_COMPENSATION,
  INVALID_VALUE,
} = require('../../shared/constants');

class MockControllerStateReader {
  /**
   * @param {object} options
   * @param {SensorSimulator} options.sensorSimulator - 模拟器实例
   */
  constructor(options = {}) {
    this._simulator = options.sensorSimulator;
    this._mockTime = { year: 2026, month: 6, day: 15, hour: 12, minute: 0, second: 0 };
    this._mockInstallStatus = {
      temp: Array(16).fill(true),
      humi: Array(16).fill(true),
      co2: Array(8).fill(true),
      nh3: Array(4).fill(true),
      press: Array(4).fill(true),
      outdoor: Array(5).fill(true),
    };
    this._mockAlarms = {
      erRead: 0,
      erMax: 0,
      tempHigh: 0,
      humiHigh: 0,
      online: 0xFFFF,
    };
    this._mockThresholds = {
      tempHigh: 350,   // 35.0℃
      tempLow: 50,     // 5.0℃
      humiHigh: 800,   // 80.0%RH
      humiLow: 200,    // 20.0%RH
    };
    this._mockCompensation = {
      temp: Array(16).fill(0),
      humi: Array(16).fill(0),
    };
    this._historyBuffer = [];
    this._rebootCount = 0;
    this._mockPortConfig = {};
  }

  setDeviceKey() {}

  // ============================================================
  // 基础读取（从模拟器影子寄存器读取）
  // ============================================================

  async readFieldZone() {
    return 1;  // 默认标准场区
  }

  async readInstallStatus() {
    return { ...this._mockInstallStatus };
  }

  async readSensorData() {
    // 从模拟器影子寄存器读取
    const temp = [];
    const humi = [];
    const co2 = [];
    const press = [];

    for (let i = 0; i < 16; i++) {
      const t = this._simulator.mockGetSensorValue(`temp_${i + 1}`);
      const h = this._simulator.mockGetSensorValue(`humi_${i + 1}`);
      temp.push(t != null ? t : 0);
      humi.push(h != null ? h : 0);
    }

    for (let i = 0; i < 8; i++) {
      const c = this._simulator.mockGetSensorValue(`co2_${i + 1}`);
      co2.push(c != null ? c : 0);
    }

    for (let i = 0; i < 4; i++) {
      const p = this._simulator.mockGetSensorValue(`press_${i + 1}`);
      press.push(p != null ? p : 0);
    }

    return {
      temp,
      humi,
      co2,
      press,
      outdoorTemp: 0,
      outdoorHumi: 0,
      raw: [],
    };
  }

  async readActualTempHumi() {
    // 计算平均值（简化：取所有已设置传感器的平均）
    const data = await this.readSensorData();
    const validTemps = data.temp.filter(t => t !== 0);
    const validHumis = data.humi.filter(h => h !== 0);

    const avgTemp = validTemps.length > 0
      ? validTemps.reduce((a, b) => a + b, 0) / validTemps.length
      : 0;
    const avgHumi = validHumis.length > 0
      ? validHumis.reduce((a, b) => a + b, 0) / validHumis.length
      : 0;

    // 检查是否有故障导致 INVALID
    const tempFault = this._simulator.getFaultStatus()['temp_1'];
    const humiFault = this._simulator.getFaultStatus()['humi_1'];

    return {
      actualTemp: tempFault && tempFault.type === 'timeout' ? INVALID_VALUE / 10 : avgTemp,
      actualHumi: humiFault && humiFault.type === 'timeout' ? INVALID_VALUE / 10 : avgHumi,
      actualTempRaw: tempFault && tempFault.type === 'timeout' ? INVALID_VALUE : Math.round(avgTemp * 10),
      actualHumiRaw: humiFault && humiFault.type === 'timeout' ? INVALID_VALUE : Math.round(avgHumi * 10),
      tempInvalid: !!(tempFault && tempFault.type === 'timeout'),
      humiInvalid: !!(humiFault && humiFault.type === 'timeout'),
    };
  }

  async readRegister(address) {
    // 告警寄存器
    if (address === BLOCK_SENSOR_ALARM.ER_READ_FLAG) return this._mockAlarms.erRead;
    if (address === BLOCK_SENSOR_ALARM.ER_MAX_FLAG) return this._mockAlarms.erMax;
    if (address === BLOCK_SENSOR_ALARM.TEMP_HIGH_ALARM) return this._mockAlarms.tempHigh;
    if (address === BLOCK_SENSOR_ALARM.HUMI_HIGH_ALARM) return this._mockAlarms.humiHigh;
    if (address === BLOCK_SENSOR_ALARM.ONLINE_STATUS) return this._mockAlarms.online;

    // 对时寄存器
    if (address === BLOCK_SENSOR_TIME.TIME_YEAR) return this._mockTime.year;
    if (address === BLOCK_SENSOR_TIME.TIME_MONTH) return this._mockTime.month;
    if (address === BLOCK_SENSOR_TIME.TIME_DAY) return this._mockTime.day;
    if (address === BLOCK_SENSOR_TIME.TIME_HOUR) return this._mockTime.hour;
    if (address === BLOCK_SENSOR_TIME.TIME_MIN) return this._mockTime.minute;
    if (address === BLOCK_SENSOR_TIME.TIME_SEC) return this._mockTime.second;
    if (address === BLOCK_SENSOR_TIME.TIME_RESULT) return 0;  // 对时成功
    if (address === BLOCK_SENSOR_TIME.REBOOT) return 0;

    // 阈值寄存器
    if (address === BLOCK_SENSOR_THRESHOLD.TEMP_HIGH_LIMIT) return this._mockThresholds.tempHigh;
    if (address === BLOCK_SENSOR_THRESHOLD.HUMI_HIGH_LIMIT) return this._mockThresholds.humiHigh;

    // 安装位寄存器
    if (address === BLOCK_SENSOR_CONFIG.INSTALL_TEMP) {
      let bitmap = 0;
      for (let i = 0; i < 16; i++) {
        if (this._mockInstallStatus.temp[i]) bitmap |= (1 << i);
      }
      return bitmap;
    }

    // 默认返回 0
    return 0;
  }

  async readRegisters(address, count) {
    const values = [];
    for (let i = 0; i < count; i++) {
      values.push(await this.readRegister(address + i));
    }
    return values;
  }

  // ============================================================
  // 配置写入（Mock 模式直接修改内存）
  // ============================================================

  async writeRegister(address, value) {
    // 阈值写入
    if (address === BLOCK_SENSOR_THRESHOLD.TEMP_HIGH_LIMIT) {
      this._mockThresholds.tempHigh = value;
      return;
    }
    if (address === BLOCK_SENSOR_THRESHOLD.HUMI_HIGH_LIMIT) {
      this._mockThresholds.humiHigh = value;
      return;
    }

    // 补偿写入
    if (address >= BLOCK_SENSOR_COMPENSATION.TEMP_COMP_BASE &&
        address < BLOCK_SENSOR_COMPENSATION.TEMP_COMP_BASE + 16) {
      const idx = address - BLOCK_SENSOR_COMPENSATION.TEMP_COMP_BASE;
      this._mockCompensation.temp[idx] = value > 32767 ? value - 65536 : value;
      return;
    }
    if (address >= BLOCK_SENSOR_COMPENSATION.HUMI_COMP_BASE &&
        address < BLOCK_SENSOR_COMPENSATION.HUMI_COMP_BASE + 16) {
      const idx = address - BLOCK_SENSOR_COMPENSATION.HUMI_COMP_BASE;
      this._mockCompensation.humi[idx] = value > 32767 ? value - 65536 : value;
      return;
    }

    // 安装位写入
    if (address === BLOCK_SENSOR_CONFIG.INSTALL_TEMP) {
      for (let i = 0; i < 16; i++) {
        this._mockInstallStatus.temp[i] = Boolean((value >> i) & 1);
      }
      return;
    }

    // 对时写入
    if (address === BLOCK_SENSOR_TIME.TIME_YEAR) { this._mockTime.year = value; return; }
    if (address === BLOCK_SENSOR_TIME.TIME_MONTH) { this._mockTime.month = value; return; }
    if (address === BLOCK_SENSOR_TIME.TIME_DAY) { this._mockTime.day = value; return; }
    if (address === BLOCK_SENSOR_TIME.TIME_HOUR) { this._mockTime.hour = value; return; }
    if (address === BLOCK_SENSOR_TIME.TIME_MIN) { this._mockTime.minute = value; return; }
    if (address === BLOCK_SENSOR_TIME.TIME_SEC) { this._mockTime.second = value; return; }
  }

  async writeRegisters(address, values) {
    for (let i = 0; i < values.length; i++) {
      await this.writeRegister(address + i, values[i]);
    }
  }

  async writeInstallBit(sensorType, bitIndex, enabled) {
    this._mockInstallStatus[sensorType][bitIndex] = enabled;
  }

  // ============================================================
  // 对时与重启（Mock 模式直接修改状态）
  // ============================================================

  async syncTime(time) {
    Object.assign(this._mockTime, time);
    const targetStr = `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')} ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}:${String(time.second).padStart(2, '0')}`;
    return {
      ok: true,
      hr17: 0,
      targetTime: targetStr,
      deviceTime: targetStr,
      deviceTimeArray: [time.year, time.month, time.day, time.hour, time.minute, time.second],
    };
  }

  async reboot(options = {}) {
    this._rebootCount++;
    return { ok: true, rebootTimeMs: 100 };
  }

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
  // 历史缓冲（Mock 模式内存模拟）
  // ============================================================

  async readHistoryTail(count) {
    return this._historyBuffer.slice(-count);
  }

  async clearHistory() {
    this._historyBuffer = [];
    return true;
  }

  /**
   * Mock：添加历史条目
   */
  mockAddHistory(entry) {
    this._historyBuffer.push(entry);
  }

  // ============================================================
  // 告警读取
  // ============================================================

  async readAlarmStatus() {
    return {
      erRead: this._mockAlarms.erRead !== 0,
      erMax: this._mockAlarms.erMax !== 0,
      tempHigh: this._mockAlarms.tempHigh !== 0,
      humiHigh: this._mockAlarms.humiHigh !== 0,
      onlineStatus: this._mockAlarms.online,
      raw: [this._mockAlarms.erRead, this._mockAlarms.erMax, this._mockAlarms.tempHigh, this._mockAlarms.humiHigh, this._mockAlarms.online],
    };
  }

  /**
   * Mock：设置告警状态
   */
  mockSetAlarm(key, value) {
    this._mockAlarms[key] = value;
  }

  /**
   * Mock：获取重启次数
   */
  mockGetRebootCount() {
    return this._rebootCount;
  }

  // ============================================================
  // 阈值/补偿/端口配置
  // ============================================================

  async readThreshold(type) {
    const map = { temp_high: 'tempHigh', temp_low: 'tempLow', humi_high: 'humiHigh', humi_low: 'humiLow' };
    return this._mockThresholds[map[type]] || 0;
  }

  async writeThreshold(type, value) {
    const map = { temp_high: 'tempHigh', temp_low: 'tempLow', humi_high: 'humiHigh', humi_low: 'humiLow' };
    this._mockThresholds[map[type]] = value;
  }

  async readPortConfig(sensorIndex) {
    return this._mockPortConfig[sensorIndex] || 6;
  }

  async writePortConfig(sensorIndex, port) {
    this._mockPortConfig[sensorIndex] = port;
  }

  async readCompensation(sensorType, index) {
    return this._mockCompensation[sensorType][index] || 0;
  }

  async writeCompensation(sensorType, index, value) {
    this._mockCompensation[sensorType][index] = value;
  }
}

module.exports = MockControllerStateReader;
