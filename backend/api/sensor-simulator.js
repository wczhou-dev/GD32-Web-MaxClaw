/**
 * backend/api/sensor-simulator.js
 * 传感器模拟器控制 API
 *
 * 提供给 HIL 脚本和 ATE 后端调用的模拟器控制接口：
 *   POST /api/sensor-simulator/profile   - 设置模拟器正常值
 *   POST /api/sensor-simulator/abnormal   - 设置异常模式
 *   POST /api/sensor-simulator/recover    - 恢复正常
 *   GET  /api/sensor-simulator/state      - 查询当前状态
 *   GET  /api/sensor-simulator/transactions - 查询交易日志
 *
 * 更新历史：
 *   v1.0  2026-06-17  初始版本
 */

'use strict';

const express = require('express');
const router = express.Router();

/**
 * POST /api/sensor-simulator/profile
 * 设置模拟器正常值（温湿度等）
 * Body: {
 *   profile: string,
 *   sensors: [{ sensorId, slaveAddress, temperature, humidity, responseMode }]
 * }
 */
router.post('/profile', (req, res) => {
  try {
    const simulator = req.app.get('sensorSimulator');
    if (!simulator) {
      return res.status(500).json({ success: false, error: '传感器模拟器未初始化' });
    }

    const { profile, sensors = [] } = req.body;

    if (!sensors.length) {
      return res.status(400).json({ success: false, error: '请提供传感器配置' });
    }

    for (const sensor of sensors) {
      const { sensorId, slaveAddress, temperature, humidity, responseMode } = sensor;

      // 设置温湿度值
      if (temperature !== undefined && humidity !== undefined) {
        const tempKey = `temp_${slaveAddress || 1}`;
        const humiKey = `humi_${slaveAddress || 1}`;

        try {
          simulator.setTempHumiPair(tempKey, temperature, humiKey, humidity);
        } catch (err) {
          console.warn(`[SimulatorAPI] 设置传感器值失败: ${err.message}`);
        }
      }

      // 如果指定了 responseMode 且不是 normal，注入故障
      if (responseMode && responseMode !== 'normal') {
        const key = `temp_${slaveAddress || 1}`;
        switch (responseMode) {
          case 'timeout':
            simulator.injectTimeout({ key });
            break;
          case 'crc_error':
            simulator.injectCrcError({ key });
            break;
          default:
            break;
        }
      }
    }

    res.json({
      success: true,
      profile: profile || 'custom',
      sensorsConfigured: sensors.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sensor-simulator/abnormal
 * 设置异常模式
 * Body: { sensorId, responseMode, duration?, value? }
 */
router.post('/abnormal', (req, res) => {
  try {
    const simulator = req.app.get('sensorSimulator');
    if (!simulator) {
      return res.status(500).json({ success: false, error: '传感器模拟器未初始化' });
    }

    const { sensorId, responseMode, duration, value } = req.body;

    if (!sensorId || !responseMode) {
      return res.status(400).json({ success: false, error: '请指定 sensorId 和 responseMode' });
    }

    // sensorId 可能是 "temp-humi-1" 或 "1"，转换为 key
    const key = sensorId.startsWith('temp_') || sensorId.startsWith('humi_')
      ? sensorId
      : `temp_${sensorId.replace(/[^0-9]/g, '') || '1'}`;

    switch (responseMode) {
      case 'timeout':
        simulator.injectTimeout({ key, persist: duration === 'until-recover' });
        break;
      case 'fixed':
        simulator.injectFixedValue({ key, value: value || 0, repeat: 100 });
        break;
      case 'outlier':
        simulator.injectOutlier({ key, value: value || 999 });
        break;
      case 'crc_error':
        simulator.injectCrcError({ key, count: 3 });
        break;
      case 'normal':
        simulator.clearFault(key);
        break;
      default:
        return res.status(400).json({ success: false, error: `未知模式: ${responseMode}` });
    }

    res.json({
      success: true,
      sensorId,
      responseMode,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sensor-simulator/recover
 * 恢复所有传感器到正常状态
 */
router.post('/recover', (req, res) => {
  try {
    const simulator = req.app.get('sensorSimulator');
    if (!simulator) {
      return res.status(500).json({ success: false, error: '传感器模拟器未初始化' });
    }

    simulator.clearAllFaults();

    // 恢复默认值
    try {
      simulator.setTempHumiPair('temp_1', 20.0, 'humi_1', 50.0);
    } catch (err) {
      // 忽略 key 不存在的情况
    }

    res.json({
      success: true,
      message: '已恢复正常状态',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sensor-simulator/state
 * 查询模拟器当前状态
 */
router.get('/state', (req, res) => {
  try {
    const simulator = req.app.get('sensorSimulator');
    if (!simulator) {
      return res.status(500).json({ success: false, error: '传感器模拟器未初始化' });
    }

    const shadows = simulator.getShadowRegisters();
    const faults = simulator.getFaultStatus();
    const fieldConfig = simulator.getFieldConfig();
    const txLog = simulator.getTransactionLog();

    // 取最后一条交易记录
    const lastTx = txLog.length > 0 ? txLog[txLog.length - 1] : null;

    // 统计故障传感器
    const faultKeys = Object.keys(faults);

    res.json({
      status: 'running',
      mode: simulator._mockMode ? 'mock' : 'serial',
      currentProfile: fieldConfig?.profile || 'default',
      shadowRegisters: shadows,
      faults: faultKeys.length > 0 ? faults : null,
      faultCount: faultKeys.length,
      lastTransaction: lastTx,
      transactionCount: txLog.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sensor-simulator/transactions
 * 查询交易日志
 * Query: ?key=temp_1&action=setSensorValue&limit=50
 */
router.get('/transactions', (req, res) => {
  try {
    const simulator = req.app.get('sensorSimulator');
    if (!simulator) {
      return res.status(500).json({ success: false, error: '传感器模拟器未初始化' });
    }

    const { key, action, limit = 100 } = req.query;
    const filter = {};
    if (key) filter.key = key;
    if (action) filter.action = action;

    let logs = simulator.getTransactionLog(filter);

    // 限制返回数量
    if (logs.length > parseInt(limit)) {
      logs = logs.slice(-parseInt(limit));
    }

    res.json({
      success: true,
      count: logs.length,
      logs,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
