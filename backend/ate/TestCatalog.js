/**
 * backend/ate/TestCatalog.js
 * ATE 测试项目录
 *
 * 职责：
 *   1. 定义测试项 ID、章节、名称、依赖、超时、判定类型
 *   2. 定义 9 项基础硬件自检项目
 *   3. 为前端项目树和后端执行队列提供统一数据源
 *   4. 绑定错误码到中文原因、排查建议
 *
 * 开发依据：
 *   - P0 方案第 3.7 节：错误码定义
 *   - P0 方案第 14 章：业务逻辑与测试执行细则
 *   - shared/constants.js：ATE_MASK, ERROR_CODE, ERROR_CODE_DETAIL
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，9 项基础硬件自检
 */

'use strict';

const { ATE_MASK, ATE_MASK_ALL, ERROR_CODE, ERROR_CODE_DETAIL } = require('../../shared/constants');

/**
 * 测试项定义
 * @typedef {object} TestItem
 * @property {number} id - 测试项 ID (与 ATE_MASK 对应)
 * @property {string} name - 测试项名称
 * @property {string} category - 分类（基础自检/业务逻辑）
 * @property {number} chapter - P0 方案章节号
 * @property {number} timeoutMs - 超时时间（毫秒）
 * @property {string}判定类型 - PASS/FAIL/SKIP 判定方式
 * @property {number[]} errorCodes - 可能的错误码列表
 * @property {string[]} dependencies - 依赖的其他测试项
 * @property {string} description - 测试项描述
 */

/**
 * 测试项目录
 */
class TestCatalog {
  constructor() {
    /**
     * 9 项基础硬件自检项目
     * 与 ATE_MASK 位定义一一对应
     */
    this._basicItems = [
      {
        id: 1,
        mask: ATE_MASK.SPI_FLASH,
        name: 'SPI Flash 自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 5000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.SPIFLASH_INIT_FAIL,
          ERROR_CODE.SPIFLASH_READ_FAIL,
          ERROR_CODE.SPIFLASH_WRITE_FAIL,
          ERROR_CODE.SPIFLASH_ERASE_FAIL,
          ERROR_CODE.SPIFLASH_VERIFY_FAIL,
        ],
        dependencies: [],
        description: '检测 SPI Flash 芯片初始化、读写、擦除和校验功能',
        steps: [
          '初始化 SPI 外设和 Flash 芯片',
          '读取 Flash ID 和容量',
          '写入测试数据并读回校验',
          '执行扇区擦除并验证',
        ],
      },
      {
        id: 2,
        mask: ATE_MASK.EEPROM,
        name: 'EEPROM 自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 5000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.EEPROM_INIT_FAIL,
          ERROR_CODE.EEPROM_READ_FAIL,
          ERROR_CODE.EEPROM_WRITE_FAIL,
          ERROR_CODE.EEPROM_VERIFY_FAIL,
        ],
        dependencies: [],
        description: '检测 EEPROM 芯片初始化、读写和校验功能',
        steps: [
          '初始化 I2C 外设和 EEPROM 芯片',
          '读取 EEPROM 容量和状态',
          '写入测试数据并读回校验',
        ],
      },
      {
        id: 3,
        mask: ATE_MASK.RTC,
        name: 'RTC 时钟自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 3000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.RTC_INIT_FAIL,
          ERROR_CODE.RTC_COUNT_FAIL,
          ERROR_CODE.RTC_BACKUP_FAIL,
        ],
        dependencies: [],
        description: '检测 RTC 芯片初始化和计时功能',
        steps: [
          '初始化 RTC 芯片',
          '读取当前时间',
          '等待 1 秒后再次读取，验证计数递增',
        ],
      },
      {
        id: 4,
        mask: ATE_MASK.RS485_1,
        name: 'RS485-1 通信自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 5000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.RS485_1_INIT_FAIL,
          ERROR_CODE.RS485_1_TX_FAIL,
          ERROR_CODE.RS485_1_RX_FAIL,
          ERROR_CODE.RS485_1_TIMEOUT,
        ],
        dependencies: [],
        description: '检测 RS485-1 串口初始化、发送和接收功能',
        steps: [
          '初始化 UART 和 RS485 收发器',
          '发送 Modbus RTU 测试帧',
          '接收并验证回环数据',
        ],
      },
      {
        id: 5,
        mask: ATE_MASK.RS485_2,
        name: 'RS485-2 通信自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 5000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.RS485_2_INIT_FAIL,
          ERROR_CODE.RS485_2_TX_FAIL,
          ERROR_CODE.RS485_2_RX_FAIL,
          ERROR_CODE.RS485_2_TIMEOUT,
        ],
        dependencies: [],
        description: '检测 RS485-2 串口初始化、发送和接收功能',
        steps: [
          '初始化 UART 和 RS485 收发器',
          '发送 Modbus RTU 测试帧',
          '接收并验证回环数据',
        ],
      },
      {
        id: 6,
        mask: ATE_MASK.CAN,
        name: 'CAN/扩展板自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 5000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.CAN_INIT_FAIL,
          ERROR_CODE.CAN_TX_FAIL,
          ERROR_CODE.CAN_RX_FAIL,
          ERROR_CODE.CAN_TIMEOUT,
          ERROR_CODE.AUX_BOARD_FAIL,
        ],
        dependencies: [],
        description: '检测 CAN 总线通信或辅助扩展板连接',
        steps: [
          '初始化 CAN 外设或 Modbus RTU',
          '发送测试帧到扩展板',
          '接收并验证回环数据',
        ],
      },
      {
        id: 7,
        mask: ATE_MASK.ADC_AO,
        name: 'ADC/AO 自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 8000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.ADC_INIT_FAIL,
          ERROR_CODE.ADC_READ_FAIL,
          ERROR_CODE.ADC_VERIFY_FAIL,
          ERROR_CODE.AO_OUTPUT_FAIL,
        ],
        dependencies: [],
        description: '检测 ADC 采样和 AO 输出功能（AO-ADC 短接环回）',
        steps: [
          '配置 AO 输出目标电压 (默认 2500mV)',
          '读取 ADC 采样值',
          '比较期望值与实际值，在容差范围内判定 PASS',
        ],
      },
      {
        id: 8,
        mask: ATE_MASK.RELAY_22,
        name: '22 路继电器自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 15000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.RELAY_INIT_FAIL,
          ERROR_CODE.RELAY_CTRL_FAIL,
          ERROR_CODE.RELAY_READ_FAIL,
          ERROR_CODE.RELAY_STUCK,
        ],
        dependencies: [],
        description: '检测 22 路继电器控制和回读功能（继电器-DI 短接环回）',
        steps: [
          '逐个控制继电器 ON',
          '读取 DI 状态验证闭环',
          '控制继电器 OFF 并验证释放',
        ],
      },
      {
        id: 9,
        mask: ATE_MASK.RS485_HOTSWAP,
        name: 'RS485 热切换自检',
        category: '基础自检',
        chapter: 3,
        timeoutMs: 8000,
       判定类型: 'PASS/FAIL',
        errorCodes: [
          ERROR_CODE.HOTSWAP_INIT_FAIL,
          ERROR_CODE.HOTSWAP_SWITCH_FAIL,
          ERROR_CODE.HOTSWAP_RECOVERY_FAIL,
        ],
        dependencies: [4, 5],  // 依赖 RS485-1 和 RS485-2
        description: '检测 RS485 总线热切换功能',
        steps: [
          '配置切换电路',
          '执行总线切换',
          '验证切换后通信正常',
          '恢复默认总线并验证',
        ],
      },
    ];

    /**
     * 业务逻辑测试项目（P0 第 14 章）
     * 第一版可选实现
     */
    this._businessItems = [
      {
        id: 101,
        name: '自动通风测试',
        category: '业务逻辑',
        chapter: 14,
        timeoutMs: 30000,
       判定类型: 'PASS/FAIL',
        errorCodes: [],
        dependencies: [],
        description: '验证自动通风逻辑在不同温湿度条件下的响应',
      },
      {
        id: 102,
        name: '开口控制测试',
        category: '业务逻辑',
        chapter: 14,
        timeoutMs: 20000,
       判定类型: 'PASS/FAIL',
        errorCodes: [],
        dependencies: [],
        description: '验证开口控制逻辑在不同压差条件下的响应',
      },
      {
        id: 103,
        name: '水帘控制测试',
        category: '业务逻辑',
        chapter: 14,
        timeoutMs: 20000,
       判定类型: 'PASS/FAIL',
        errorCodes: [],
        dependencies: [],
        description: '验证水帘控制逻辑在高温条件下的响应',
      },
      {
        id: 104,
        name: '喷淋控制测试',
        category: '业务逻辑',
        chapter: 14,
        timeoutMs: 20000,
       判定类型: 'PASS/FAIL',
        errorCodes: [],
        dependencies: [],
        description: '验证喷淋控制逻辑在高温条件下的响应',
      },
      {
        id: 105,
        name: '加热控制测试',
        category: '业务逻辑',
        chapter: 14,
        timeoutMs: 20000,
       判定类型: 'PASS/FAIL',
        errorCodes: [],
        dependencies: [],
        description: '验证加热控制逻辑在低温条件下的响应',
      },
    ];
  }

  // ============================================================
  // 公共方法
  // ============================================================

  /**
   * 获取所有基础硬件自检项目
   * @returns {TestItem[]}
   */
  getBasicItems() {
    return [...this._basicItems];
  }

  /**
   * 获取所有业务逻辑测试项目
   * @returns {TestItem[]}
   */
  getBusinessItems() {
    return [...this._businessItems];
  }

  /**
   * 获取所有测试项目（基础 + 业务）
   * @returns {TestItem[]}
   */
  getAllItems() {
    return [...this._basicItems, ...this._businessItems];
  }

  /**
   * 根据 ID 获取测试项
   * @param {number} id - 测试项 ID
   * @returns {TestItem|null}
   */
  getItemById(id) {
    return this._basicItems.find(item => item.id === id) ||
           this._businessItems.find(item => item.id === id) ||
           null;
  }

  /**
   * 根据掩码获取测试项列表
   * @param {number} mask - 测试掩码
   * @returns {TestItem[]}
   */
  getItemsByMask(mask) {
    return this._basicItems.filter(item => (mask & item.mask) !== 0);
  }

  /**
   * 获取测试项的错误码详情
   * @param {number} errorCode - 错误码
   * @returns {object|null}
   */
  getErrorDetail(errorCode) {
    return ERROR_CODE_DETAIL[errorCode] || null;
  }

  /**
   * 生成前端项目树数据结构
   * @returns {Array<object>}
   */
  getProjectTree() {
    const basicTree = {
      id: 'basic',
      name: '基础硬件自检',
      category: '基础自检',
      children: this._basicItems.map(item => ({
        id: item.id,
        name: item.name,
        timeout: item.timeoutMs,
        status: 'pending',
      })),
    };

    const businessTree = {
      id: 'business',
      name: '业务逻辑测试',
      category: '业务逻辑',
      children: this._businessItems.map(item => ({
        id: item.id,
        name: item.name,
        timeout: item.timeoutMs,
        status: 'pending',
      })),
    };

    return [basicTree, businessTree];
  }

  /**
   * 验证测试掩码是否有效
   * 仅允许 bit0-bit8 覆盖 9 项基础自检
   * @param {number} mask
   * @returns {boolean}
   */
  isValidMask(mask) {
    return (mask & ~ATE_MASK_ALL) === 0;
  }

  /**
   * 过滤测试掩码，移除未定义位
   * @param {number} mask
   * @returns {number}
   */
  filterMask(mask) {
    return mask & ATE_MASK_ALL;
  }
}

module.exports = TestCatalog;
