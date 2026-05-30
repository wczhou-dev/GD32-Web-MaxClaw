/**
 * backend/ate/TestProtocol.js
 * ATE 测试协议解析器
 *
 * 职责：
 *   1. 解析 0x8000-0x8027 原始寄存器为结构化数据
 *   2. 解析单项结果、错误码、诊断值
 *   3. 提供寄存器读写辅助方法
 *
 * 开发依据：
 *   - P0 方案第 3 章：Modbus TCP 寄存器映射大规范
 *   - P0 方案第 3.7 节：错误码定义
 *   - shared/constants.js：BLOCK_TEST_STATUS, TEST_STATUS, SINGLE_RESULT
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本
 */

'use strict';

const {
  BLOCK_TEST_STATUS,
  BLOCK_TEST_CONFIG,
  TEST_CMD,
  TEST_STATUS,
  TEST_STATUS_TEXT,
  SINGLE_RESULT,
  SINGLE_RESULT_TEXT,
  ERROR_CODE,
  ERROR_CODE_DETAIL,
} = require('../../shared/constants');

/**
 * ATE 测试协议解析器
 */
class TestProtocol {
  constructor() {
    /**
     * 寄存器缓存
     */
    this._registerCache = {};
  }

  // ============================================================
  // 寄存器解析方法
  // ============================================================

  /**
   * 解析测试状态寄存器区 (0x8000-0x8027)
   * @param {number[]} registers - 原始寄存器数组（40 个）
   * @returns {object} 结构化测试状态
   */
  parseTestStatusBlock(registers) {
    if (!registers || registers.length < 40) {
      throw new Error('寄存器数据不足，需要 40 个');
    }

    return {
      // 控制命令 (0x8000)
      controlCommand: {
        value: registers[0],
        text: this.getControlCommandText(registers[0]),
      },

      // 通风等级 (0x8001)
      ventilationLevel: registers[1],

      // 当前测试项 ID (0x8002)
      currentItemId: registers[2],

      // 测试进度 (0x8003)
      progress: registers[3],

      // 整体状态码 (0x8004)
      overallStatus: {
        value: registers[4],
        text: TEST_STATUS_TEXT[registers[4]] || '未知',
        isFinished: this.isFinishedStatus(registers[4]),
      },

      // 会话 ID (0x8005-0x8006) - 寄存器偏移 5-6
      sessionId: (registers[5] << 16) | registers[6],

      // 测试掩码 (0x8006) - 寄存器偏移 6（0x8006 - 0x8000 = 6）
      testMask: registers[6],

      // 失败项 ID (0x8007) - 寄存器偏移 7
      failedItemId: registers[7],

      // 单项结果 (0x8010-0x8017)
      singleResults: this.parseSingleResults(registers.slice(16, 24)),

      // 错误码 (0x8020-0x8027)
      errorCodes: this.parseErrorCodes(registers.slice(32, 40)),

      // 诊断信息 (0x8021-0x8023)
      diagnostics: {
        channel: registers[33],      // 0x8021
        expected: registers[34],     // 0x8022
        actual: registers[35],       // 0x8023
      },

      // 原始寄存器
      raw: registers,
    };
  }

  /**
   * 解析单项结果 (0x8010-0x8017)
   * @param {number[]} registers - 8 个寄存器
   * @returns {Array<object>}
   */
  parseSingleResults(registers) {
    const results = [];
    for (let i = 0; i < 8; i++) {
      const itemId = i + 1;
      const value = registers[i] || 0;
      results.push({
        itemId,
        value,
        text: SINGLE_RESULT_TEXT[value] || '未知',
        isPass: value === SINGLE_RESULT.PASS,
        isFail: value === SINGLE_RESULT.FAIL,
        isTesting: value === SINGLE_RESULT.TESTING,
        isPending: value === SINGLE_RESULT.PENDING,
      });
    }
    return results;
  }

  /**
   * 解析错误码 (0x8020-0x8027)
   * @param {number[]} registers - 8 个寄存器
   * @returns {Array<object>}
   */
  parseErrorCodes(registers) {
    const codes = [];
    for (let i = 0; i < 8; i++) {
      const itemId = i + 1;
      const errorCode = registers[i] || 0;
      const detail = ERROR_CODE_DETAIL[errorCode] || null;
      codes.push({
        itemId,
        errorCode,
        hex: errorCode ? `0x${errorCode.toString(16).toUpperCase().padStart(4, '0')}` : '0x0000',
        hasError: errorCode !== 0,
        detail,
      });
    }
    return codes;
  }

  /**
   * 解析测试配置寄存器区 (0x8030-0x803F)
   * @param {number[]} registers - 原始寄存器数组
   * @returns {object}
   */
  parseTestConfigBlock(registers) {
    if (!registers || registers.length < 16) {
      throw new Error('寄存器数据不足，需要 16 个');
    }

    return {
      aoTarget1: registers[0],   // 0x8030
      aoTarget2: registers[1],   // 0x8031
      aoTarget3: registers[2],   // 0x8032
      aoTarget4: registers[3],   // 0x8033
      relayDiMap: registers[4],  // 0x8034
      rs485SlaveId: registers[5], // 0x8035
      deviceModel: registers[8], // 0x8038
      ventMode: registers[9],    // 0x8039
      raw: registers,
    };
  }

  // ============================================================
  // 寄存器构建方法
  // ============================================================

  /**
   * 构建控制命令寄存器值
   * @param {string} command - 命令类型：start/stop/reset/idle
   * @returns {number}
   */
  buildControlCommand(command) {
    const cmdMap = {
      'start': TEST_CMD.START,
      'stop': TEST_CMD.STOP,
      'reset': TEST_CMD.RESET,
      'idle': TEST_CMD.IDLE,
    };
    return cmdMap[command] || TEST_CMD.IDLE;
  }

  /**
   * 构建测试掩码
   * @param {number[]} itemIds - 测试项 ID 列表
   * @returns {number}
   */
  buildTestMask(itemIds) {
    let mask = 0;
    const maskMap = {
      1: 1 << 0,  // SPI Flash
      2: 1 << 1,  // EEPROM
      3: 1 << 2,  // RTC
      4: 1 << 3,  // RS485-1
      5: 1 << 4,  // RS485-2
      6: 1 << 5,  // CAN
      7: 1 << 6,  // ADC/AO
      8: 1 << 7,  // 继电器
      9: 1 << 8,  // RS485 热切换
    };

    for (const id of itemIds) {
      if (maskMap[id]) {
        mask |= maskMap[id];
      }
    }

    return mask;
  }

  /**
   * 构建设备型号寄存器值
   * @param {string} model - 设备型号：9200/9250/9300
   * @returns {number}
   */
  buildDeviceModel(model) {
    if (model === '9250' || model === '9300') {
      return 1;
    }
    return 0;
  }

  /**
   * 构建通风模式寄存器值
   * @param {string} mode - 通风模式：negative/positive
   * @returns {number}
   */
  buildVentMode(mode) {
    if (mode === 'positive') {
      return 1;
    }
    return 0;
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /**
   * 获取控制命令文本
   * @param {number} cmd
   * @returns {string}
   */
  getControlCommandText(cmd) {
    const cmdTexts = {
      [TEST_CMD.IDLE]: '空闲',
      [TEST_CMD.START]: '启动',
      [TEST_CMD.STOP]: '停止',
      [TEST_CMD.RESET]: '复位',
    };
    return cmdTexts[cmd] || '未知';
  }

  /**
   * 检查状态是否为结束状态
   * @param {number} status
   * @returns {boolean}
   */
  isFinishedStatus(status) {
    return status === TEST_STATUS.PASS ||
           status === TEST_STATUS.FAIL ||
           status === TEST_STATUS.ABORTED ||
           status === TEST_STATUS.TIMEOUT;
  }

  /**
   * 获取单项结果的 CSS 类名
   * @param {number} result
   * @returns {string}
   */
  getResultCssClass(result) {
    const classMap = {
      [SINGLE_RESULT.PENDING]: 'result-pending',
      [SINGLE_RESULT.TESTING]: 'result-testing',
      [SINGLE_RESULT.PASS]: 'result-pass',
      [SINGLE_RESULT.FAIL]: 'result-fail',
      [SINGLE_RESULT.SKIP]: 'result-skip',
      [SINGLE_RESULT.TIMEOUT]: 'result-timeout',
    };
    return classMap[result] || 'result-unknown';
  }

  /**
   * 获取单项结果的颜色
   * @param {number} result
   * @returns {string}
   */
  getResultColor(result) {
    const colorMap = {
      [SINGLE_RESULT.PENDING]: '#d9d9d9',
      [SINGLE_RESULT.TESTING]: '#1890ff',
      [SINGLE_RESULT.PASS]: '#52c41a',
      [SINGLE_RESULT.FAIL]: '#ff4d4f',
      [SINGLE_RESULT.SKIP]: '#faad14',
      [SINGLE_RESULT.TIMEOUT]: '#faad14',
    };
    return colorMap[result] || '#d9d9d9';
  }

  /**
   * 解析错误码为中文描述
   * @param {number} errorCode
   * @returns {string}
   */
  getErrorDescription(errorCode) {
    if (errorCode === 0) return '无错误';
    const detail = ERROR_CODE_DETAIL[errorCode];
    if (detail) {
      return `${detail.name}：${detail.cause}`;
    }
    return `未知错误码：0x${errorCode.toString(16).toUpperCase().padStart(4, '0')}`;
  }

  /**
   * 获取排障建议
   * @param {number} errorCode
   * @returns {string}
   */
  getTroubleshootingSuggestion(errorCode) {
    if (errorCode === 0) return '无';
    const detail = ERROR_CODE_DETAIL[errorCode];
    if (detail) {
      return detail.suggestion;
    }
    return '请联系技术支持';
  }
}

module.exports = TestProtocol;
