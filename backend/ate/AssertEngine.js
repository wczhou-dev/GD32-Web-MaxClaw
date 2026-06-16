/**
 * backend/ate/AssertEngine.js
 * P1 传感器测试断言引擎
 *
 * 职责：
 *   1. 提供结构化断言函数，返回 { pass, code, expected, actual, message }
 *   2. 支持浮点误差、位图、告警、历史快照等断言类型
 *   3. 断言结果可直接进入测试报告
 *
 * 开发依据：
 *   - 传感器自动测试内容开发清单P1.md §4.1.1（断言规则）
 *   - 传感器自动测试任务开发列表P1.md §八（断言与报告任务）
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本
 */

'use strict';

const { INVALID_VALUE, ERROR_CODE } = require('../../shared/constants');

/**
 * 断言结果
 * @typedef {object} AssertionResult
 * @property {boolean} pass - 是否通过
 * @property {string} code - 错误码名称
 * @property {*} expected - 期望值
 * @property {*} actual - 实际值
 * @property {number} [tolerance] - 容差
 * @property {string} message - 描述信息
 */

class AssertEngine {
  // ============================================================
  // 基础断言
  // ============================================================

  /**
   * 浮点误差断言
   * @param {number} actual
   * @param {number} expected
   * @param {number} tolerance
   * @param {string} [message]
   * @returns {AssertionResult}
   */
  assertClose(actual, expected, tolerance = 0.2, message = '') {
    const diff = Math.abs(Number(actual) - Number(expected));
    const pass = diff <= tolerance;
    return {
      pass,
      code: pass ? null : 'VALUE_OUT_OF_TOLERANCE',
      expected,
      actual,
      tolerance,
      diff,
      message: message || (pass
        ? `值匹配: ${actual} ≈ ${expected} (差值 ${diff.toFixed(3)}, 容差 ${tolerance})`
        : `值不匹配: actual=${actual}, expected=${expected}, diff=${diff.toFixed(3)} > tolerance=${tolerance}`),
    };
  }

  /**
   * 精确断言
   * @param {*} actual
   * @param {*} expected
   * @param {string} [message]
   * @returns {AssertionResult}
   */
  assertEqual(actual, expected, message = '') {
    const pass = actual === expected;
    return {
      pass,
      code: pass ? null : 'VALUE_NOT_EQUAL',
      expected,
      actual,
      message: message || (pass
        ? `值精确匹配: ${actual}`
        : `值不匹配: actual=${actual}, expected=${expected}`),
    };
  }

  /**
   * 断言值在有效范围内（非 0 且非 INVALID_VALUE）
   * @param {number} value
   * @param {string} [message]
   * @returns {AssertionResult}
   */
  assertValid(value, message = '') {
    const pass = value !== 0 && value !== INVALID_VALUE && value != null;
    return {
      pass,
      code: pass ? null : 'VALUE_INVALID',
      expected: '有效值 (非0, 非INVALID)',
      actual: value,
      message: message || (pass
        ? `值有效: ${value}`
        : `值无效: ${value}`),
    };
  }

  /**
   * 断言值为无效值
   * @param {number} value
   * @param {string} [message]
   * @returns {AssertionResult}
   */
  assertInvalid(value, message = '') {
    const pass = value === INVALID_VALUE || value === 0;
    return {
      pass,
      code: pass ? null : 'VALUE_SHOULD_BE_INVALID',
      expected: 'INVALID_VALUE',
      actual: value,
      message: message || (pass
        ? `值为无效: ${value}`
        : `值应为无效但实际为: ${value}`),
    };
  }

  // ============================================================
  // 位图断言
  // ============================================================

  /**
   * 断言位图中某位已置位
   * @param {number} bitmap
   * @param {number} bitPos 0-based 位位置
   * @param {string} [message]
   * @returns {AssertionResult}
   */
  assertBitSet(bitmap, bitPos, message = '') {
    const pass = Boolean((bitmap >> bitPos) & 1);
    return {
      pass,
      code: pass ? null : 'BIT_NOT_SET',
      expected: `bit${bitPos} = 1`,
      actual: `bit${bitPos} = ${pass ? 1 : 0} (bitmap=0x${bitmap.toString(16).padStart(4, '0')})`,
      message: message || (pass
        ? `bit${bitPos} 已置位`
        : `bit${bitPos} 未置位 (bitmap=0x${bitmap.toString(16).padStart(4, '0')})`),
    };
  }

  /**
   * 断言位图中某位已清零
   * @param {number} bitmap
   * @param {number} bitPos 0-based 位位置
   * @param {string} [message]
   * @returns {AssertionResult}
   */
  assertBitClear(bitmap, bitPos, message = '') {
    const pass = !((bitmap >> bitPos) & 1);
    return {
      pass,
      code: pass ? null : 'BIT_NOT_CLEARED',
      expected: `bit${bitPos} = 0`,
      actual: `bit${bitPos} = ${pass ? 0 : 1} (bitmap=0x${bitmap.toString(16).padStart(4, '0')})`,
      message: message || (pass
        ? `bit${bitPos} 已清零`
        : `bit${bitPos} 未清零 (bitmap=0x${bitmap.toString(16).padStart(4, '0')})`),
    };
  }

  // ============================================================
  // 传感器专用断言
  // ============================================================

  /**
   * 断言传感器值与模拟器预设值一致
   * @param {number} actualValue 环控器读取值
   * @param {number} expectedValue 模拟器预设值
   * @param {number} tolerance 容差
   * @param {string} sensorKey 传感器标识
   * @returns {AssertionResult}
   */
  assertSensorValue(actualValue, expectedValue, tolerance, sensorKey) {
    const result = this.assertClose(actualValue, expectedValue, tolerance,
      `${sensorKey}: actual=${actualValue}, expected=${expectedValue}`);
    if (!result.pass) {
      result.code = ERROR_CODE.SENSOR_VALUE_MISMATCH;
    }
    return result;
  }

  /**
   * 断言 ActualTemp/ActualHumi 平均值
   * @param {number} actualActual 环控器 Actual 值
   * @param {number} expectedActual 期望平均值
   * @param {number} tolerance 容差
   * @param {string} type 'temp' 或 'humi'
   * @returns {AssertionResult}
   */
  assertActualValue(actualActual, expectedActual, tolerance, type) {
    const result = this.assertClose(actualActual, expectedActual, tolerance,
      `Actual${type === 'temp' ? 'Temp' : 'Humi'}: actual=${actualActual}, expected=${expectedActual}`);
    if (!result.pass) {
      result.code = ERROR_CODE.SENSOR_ACTUAL_MISMATCH;
    }
    return result;
  }

  /**
   * 断言历史缓冲条目
   * @param {object} entry 历史条目 { tm_hour, temp, humi }
   * @param {object} expected { tm_hour, temp, humi }
   * @param {number} tolerance 温湿度容差
   * @returns {AssertionResult[]}
   */
  assertHistoryEntry(entry, expected, tolerance = 0.2) {
    const results = [];

    const hourResult = this.assertEqual(entry.tm_hour, expected.tm_hour,
      `历史小时: actual=${entry.tm_hour}, expected=${expected.tm_hour}`);
    if (!hourResult.pass) hourResult.code = ERROR_CODE.SENSOR_HISTORY_MISMATCH;
    results.push(hourResult);

    const tempResult = this.assertClose(entry.temp, expected.temp, tolerance,
      `历史温度: actual=${entry.temp}, expected=${expected.temp}`);
    if (!tempResult.pass) tempResult.code = ERROR_CODE.SENSOR_HISTORY_MISMATCH;
    results.push(tempResult);

    const humiResult = this.assertClose(entry.humi, expected.humi, tolerance,
      `历史湿度: actual=${entry.humi}, expected=${expected.humi}`);
    if (!humiResult.pass) humiResult.code = ERROR_CODE.SENSOR_HISTORY_MISMATCH;
    results.push(humiResult);

    return results;
  }

  /**
   * 断言启动回退值
   * @param {object} actual { actualTemp, actualHumi }
   * @param {object} expected { temp, humi }
   * @param {number} tolerance 容差
   * @returns {AssertionResult[]}
   */
  assertBootFallback(actual, expected, tolerance = 0.2) {
    const results = [];

    const tempResult = this.assertClose(actual.actualTemp, expected.temp, tolerance,
      `启动回退温度: actual=${actual.actualTemp}, expected=${expected.temp}`);
    if (!tempResult.pass) tempResult.code = ERROR_CODE.SENSOR_BOOT_FALLBACK_FAIL;
    results.push(tempResult);

    const humiResult = this.assertClose(actual.actualHumi, expected.humi, tolerance,
      `启动回退湿度: actual=${actual.actualHumi}, expected=${expected.humi}`);
    if (!humiResult.pass) humiResult.code = ERROR_CODE.SENSOR_BOOT_FALLBACK_FAIL;
    results.push(humiResult);

    return results;
  }

  /**
   * 断言对时成功
   * @param {number} hr17Result HR17 寄存器值
   * @param {object} actualTime 设备时间 { year, month, day, hour, minute, second }
   * @param {object} targetTime 目标时间
   * @returns {AssertionResult[]}
   */
  assertTimeSync(hr17Result, actualTime, targetTime) {
    const results = [];

    const hrResult = this.assertEqual(hr17Result, 0,
      `对时结果: HR17=${hr17Result}, 期望=0`);
    if (!hrResult.pass) hrResult.code = ERROR_CODE.SENSOR_TIME_SYNC_FAIL;
    results.push(hrResult);

    const hourResult = this.assertEqual(actualTime.hour, targetTime.hour,
      `小时匹配: actual=${actualTime.hour}, expected=${targetTime.hour}`);
    if (!hourResult.pass) hourResult.code = ERROR_CODE.SENSOR_TIME_SYNC_FAIL;
    results.push(hourResult);

    const minResult = this.assertEqual(actualTime.minute, targetTime.minute,
      `分钟匹配: actual=${actualTime.minute}, expected=${targetTime.minute}`);
    if (!minResult.pass) minResult.code = ERROR_CODE.SENSOR_TIME_SYNC_FAIL;
    results.push(minResult);

    return results;
  }

  // ============================================================
  // 批量断言工具
  // ============================================================

  /**
   * 检查一批断言结果中是否有失败
   * @param {AssertionResult[]} results
   * @returns {{ allPassed: boolean, failures: AssertionResult[] }}
   */
  checkResults(results) {
    const failures = results.filter(r => !r.pass);
    return {
      allPassed: failures.length === 0,
      failures,
      total: results.length,
      passed: results.length - failures.length,
    };
  }

  /**
   * 将断言结果转换为报告格式
   * @param {AssertionResult[]} results
   * @returns {object}
   */
  toReportFormat(results) {
    return results.map(r => ({
      pass: r.pass,
      code: r.code,
      expected: r.expected,
      actual: r.actual,
      tolerance: r.tolerance,
      message: r.message,
    }));
  }
}

module.exports = AssertEngine;
