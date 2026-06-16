/**
 * shared/constants.js
 * MaxClaw ATE 系统公共常量定义
 *
 * 职责：
 *   1. 为前后端提供统一的寄存器地址、状态码、错误码、协议帧格式等常量。
 *   2. 消除前端 Vue 组件、后端 Node.js 服务和报告模块中的魔数硬编码。
 *   3. 确保前后端协议同步，避免通信歧义。
 *
 * 开发依据：
 *   - P0 方案第 3 章：Modbus TCP 寄存器映射大规范
 *   - P0 方案第 4 章：TCP+JSON ATE 协议规范
 *   - P0 方案第 17 章：环控器固件接口定义
 *
 * 更新历史：
 *   v1.0  2026-05-30  初始版本，覆盖 ATE 寄存器区、测试掩码、状态码、错误码、帧协议常量
 */

// ============================================================
// 1. ATE Modbus TCP 寄存器区块定义
// ============================================================

/**
 * ATE 测试控制与状态寄存器区 (BLOCK_TEST_STATUS)
 * 地址范围：0x8000 - 0x802F
 * 用途：ATE 测试过程控制、整体进度、单项测试结果与故障错误码
 */
const BLOCK_TEST_STATUS = {
  START: 0x8000,              // 控制命令：R/W，uint16，0=idle, 1=start, 2=stop, 3=reset
  VENTILATION_LEVEL: 0x8001,  // 当前通风等级：RO，uint16
  CURRENT_ITEM: 0x8002,       // 当前测试项 ID：RO，uint16
  PROGRESS: 0x8003,           // 测试进度百分比：RO，uint16，0-100
  OVERALL_STATUS: 0x8004,     // 整体测试状态码：RO，uint16
  SESSION_ID_HIGH: 0x8005,    // 会话 ID 高 16 位：RO，uint16
  SESSION_ID_LOW: 0x8006,     // 会话 ID 低 16 位：RO，uint16
  ERROR_ITEM_ID: 0x8007,      // 失败项 ID：RO，uint16
  TEST_MASK: 0x8008,          // 测试项掩码：R/W，uint16，0x01FF 表示全部 9 项
  SINGLE_RESULT_BASE: 0x8010, // 单项自检结果码基址：RO，uint16[9]，0x8010-0x8018
  ERROR_CODE_BASE: 0x8020,    // 故障错误码基址：RO，uint16[9]，0x8020-0x8028
  DIAG_CHANNEL: 0x802C,       // 诊断通道号：RO，uint16（移到 0x802C，避免与 ERROR_CODE 重叠）
  DIAG_EXPECTED: 0x802D,      // 诊断期望值：RO，uint16，单位 mV
  DIAG_ACTUAL: 0x802E,        // 诊断实际值：RO，uint16，单位 mV
  END: 0x802F                 // 区块结束地址（不含）
};

/**
 * ATE 测试状态寄存器块总读取长度（寄存器个数）
 * 0x8000 - 0x802F = 48 个寄存器
 */
const ATE_TEST_BLOCK_SIZE = 48;

/**
 * ATE 测试参数配置寄存器区 (BLOCK_TEST_CONFIG)
 * 地址范围：0x8030 - 0x803F
 * 用途：ATE 测试阈值设定、继电器与 DI 的物理短接闭环映射关系配置
 */
const BLOCK_TEST_CONFIG = {
  AO_TARGET_1: 0x8030,    // AO 测试目标电压 1：R/W，uint16，单位 mV，默认 2500
  AO_TARGET_2: 0x8031,    // AO 测试目标电压 2：R/W，uint16，单位 mV，默认 2500
  AO_TARGET_3: 0x8032,    // AO 测试目标电压 3：R/W，uint16，单位 mV，默认 2500
  AO_TARGET_4: 0x8033,    // AO 测试目标电压 4：R/W，uint16，单位 mV，默认 2500
  RELAY_DI_MAP: 0x8034,   // 继电器-DI 闭环映射：R/W，uint16
  RS485_SLAVE_ID: 0x8035, // RS485 从站 ID 配置：R/W，uint16
  DEVICE_MODEL: 0x8038,   // 设备型号：R/W，uint16，0=9200，1=9250/9300
  VENT_MODE: 0x8039,      // 通风逻辑控制：R/W，uint16，0=负压通风，1=微正压通风
  END: 0x803F             // 区块结束地址（不含）
};

/**
 * 环境数据寄存器区 (BLOCK_ENV)
 * 地址范围：0x1001 - 0x1050
 * 用途：传感器数据读取，用于业务逻辑测试验证
 */
const BLOCK_ENV = {
  START: 0x1001,
  TEMP_1: 0x1001,        // 1#舍内温度：RO，int16，换算 val/10
  HUMI_1: 0x1002,        // 1#舍内湿度：RO，uint16，换算 val/10
  TEMP_2: 0x1003,
  HUMI_2: 0x1004,
  TEMP_3: 0x1005,
  HUMI_3: 0x1006,
  TEMP_4: 0x1007,
  HUMI_4: 0x1008,
  CO2_1: 0x1021,         // 1#室内 CO2：RO，uint16，原值
  NH3_1: 0x1029,         // 1#室内氨气：RO，uint16，原值
  WIND_1: 0x102D,        // 1#室内风速：RO，uint16，换算 val/10
  OUTDOOR_TEMP: 0x1039,  // 舍外温度：RO，int16，换算 val/10
  OUTDOOR_HUMI: 0x103A,  // 舍外湿度：RO，uint16，换算 val/10
  PRESS_1: 0x1042,       // 1#室内压差：RO，int16，换算 val/10
  END: 0x1050
};

/**
 * 外设硬件接口区 (BLOCK_HW)
 * 地址范围：0x4001 - 0x4015, 0x5001 - 0x5004
 * 用途：继电器、DI、AI、AO 状态反馈与控制
 */
const BLOCK_HW = {
  RELAY_STATUS: 0x4001,   // 继电器状态：RO，uint32，bit0-21 对应 R1-R22（0-based）
  AO1_FEEDBACK: 0x4003,   // AO1 反馈：RO，uint16，换算 val/10
  AO2_FEEDBACK: 0x4004,   // AO2 反馈：RO，uint16，换算 val/10
  DI_STATUS: 0x4007,      // DI 输入状态：RO，uint16，bit0-9 对应 DI1-DI10（0-based）
  AI1: 0x4008,            // AI1 电压反馈：RO，uint16，换算 val/10
  AI2: 0x4009,
  AI3: 0x400A,
  AI4: 0x400B,
  RELAY_CMD: 0x5001,      // 继电器指令：R/W，uint32，强制启停
  AO1_SET: 0x5003,        // AO1 设定值：R/W，uint16
  AO2_SET: 0x5004         // AO2 设定值：R/W，uint16
};

/**
 * 传感器配置寄存器区 (BLOCK_SENSOR_CONFIG)
 * 用途：场区类型、传感器安装状态、阈值、补偿值等配置
 */
const BLOCK_SENSOR_CONFIG = {
  FIELD_ZONE_TYPE: 0x0019,     // 场区类型：RO，uint16，0=未配置, 1=A, 2=B, 3=C
  INSTALL_TEMP: 0x700A,        // 室内温度安装位：R/W，uint16，bit0~bit15 = 1#~16#
  INSTALL_HUMI: 0x700B,        // 室内湿度安装位：R/W，uint16，bit0~bit15 = 1#~16#
  INSTALL_CO2: 0x700C,         // 室内CO2安装位：R/W，uint16，bit0~bit7 = 1#~8#
  INSTALL_NH3: 0x700D,         // 室内氨气安装位：R/W，uint16，bit0~bit3 = 1#~4#
  INSTALL_PRESS: 0x700E,       // 室内压差安装位：R/W，uint16，bit0~bit3 = 1#~4#
  INSTALL_OUTDOOR: 0x700F,     // 室外传感器安装位：R/W，uint16，bit0=室外TH, bit1~bit4=水帘1~4
};

/**
 * 传感器 Actual 值寄存器
 * 用途：读取环控器计算后的实际平均温湿度
 */
const SENSOR_ACTUAL = {
  ACTUAL_TEMP: 0x103B,    // 室内实际平均温度：RO，int16，换算 val/10 → ℃
  ACTUAL_HUMI: 0x103C,    // 室内实际平均湿度：RO，uint16，换算 val/10 → %RH
};

/**
 * 对时与重启寄存器区 (BLOCK_SENSOR_TIME)
 * 用途：Modbus TCP 对时和设备重启
 */
const BLOCK_SENSOR_TIME = {
  TIME_YEAR: 10,           // HR10：年
  TIME_MONTH: 11,          // HR11：月
  TIME_DAY: 12,            // HR12：日
  TIME_HOUR: 13,           // HR13：时
  TIME_MIN: 14,            // HR14：分
  TIME_SEC: 15,            // HR15：秒
  TIME_TRIGGER: 16,        // HR16：写 1 触发对时
  TIME_RESULT: 17,         // HR17：读 0 表示对时成功
  REBOOT: 18,              // HR18：写 0x55AA 触发重启
  REBOOT_MAGIC: 0x55AA,    // 重启魔数
};

/**
 * 传感器无效值
 */
const INVALID_VALUE = 0x7FFF;

/**
 * 告警寄存器区 (BLOCK_SENSOR_ALARM)
 * 用途：读取传感器告警状态
 */
const BLOCK_SENSOR_ALARM = {
  ER_READ_FLAG: 0x7030,       // ErRead 告警标志：RO，uint16，bit0~bit15 对应传感器
  ER_MAX_FLAG: 0x7031,        // ErMax 告警标志：RO，uint16
  TEMP_HIGH_ALARM: 0x7032,    // 温度高限告警：RO，uint16
  HUMI_HIGH_ALARM: 0x7033,    // 湿度高限告警：RO，uint16
  ONLINE_STATUS: 0x7034,      // 传感器在线状态：RO，uint16，bit0~bit15
};

/**
 * 阈值配置寄存器区 (BLOCK_SENSOR_THRESHOLD)
 * 用途：读写传感器告警阈值
 */
const BLOCK_SENSOR_THRESHOLD = {
  TEMP_HIGH_LIMIT: 0x7040,    // 温度高限阈值：R/W，uint16，val/10 → ℃
  TEMP_LOW_LIMIT: 0x7041,     // 温度低限阈值：R/W，uint16，val/10 → ℃
  HUMI_HIGH_LIMIT: 0x7042,    // 湿度高限阈值：R/W，uint16，val/10 → %RH
  HUMI_LOW_LIMIT: 0x7043,     // 湿度低限阈值：R/W，uint16，val/10 → %RH
};

/**
 * 补偿值配置寄存器区 (BLOCK_SENSOR_COMPENSATION)
 * 用途：读写传感器补偿值
 */
const BLOCK_SENSOR_COMPENSATION = {
  TEMP_COMP_BASE: 0x7050,     // 温度补偿基址：R/W，int16，val/10 → ℃，0x7050+i 对应第 i+1 路
  HUMI_COMP_BASE: 0x7060,     // 湿度补偿基址：R/W，int16，val/10 → %RH，0x7060+i 对应第 i+1 路
};

// ============================================================
// 2. ATE 测试掩码定义
// ============================================================

/**
 * ATE 测试掩码：bit0-bit8 覆盖 9 项基础硬件自检
 * 下发前必须过滤未定义位，仅允许 0x01FF 范围内的掩码
 */
const ATE_MASK_ALL = 0x01FF;  // 全部 9 项

const ATE_MASK = {
  SPI_FLASH:   1 << 0,  // 0x0001 - SPI Flash 自检
  EEPROM:      1 << 1,  // 0x0002 - EEPROM 自检
  RTC:         1 << 2,  // 0x0004 - RTC 时钟自检
  RS485_1:     1 << 3,  // 0x0008 - RS485-1 通信自检
  RS485_2:     1 << 4,  // 0x0010 - RS485-2 通信自检
  CAN:         1 << 5,  // 0x0020 - CAN/扩展板自检
  ADC_AO:      1 << 6,  // 0x0040 - ADC/AO 自检
  RELAY_22:    1 << 7,  // 0x0080 - 22 路继电器自检
  RS485_HOTSWAP: 1 << 8 // 0x0100 - RS485 热切换自检
};

// ============================================================
// 3. 测试控制命令定义
// ============================================================

/**
 * 写入 BLOCK_TEST_STATUS.START (0x8000) 的控制命令
 */
const TEST_CMD = {
  IDLE:   0,  // 空闲
  START:  1,  // 启动测试
  STOP:   2,  // 停止测试（触发安全释放）
  RESET:  3   // 复位测试状态（清空结果和错误码）
};

// ============================================================
// 4. 整体测试状态码 (OVERALL_STATUS)
// ============================================================

/**
 * 写入 BLOCK_TEST_STATUS.OVERALL_STATUS (0x8004) 的状态码
 * 固件状态机按此状态码上报当前测试阶段
 */
const TEST_STATUS = {
  IDLE:     0,  // 空闲/未启动
  RUNNING:  1,  // 测试进行中
  PASS:     2,  // 全部通过
  FAIL:     3,  // 存在失败项
  ABORTED:  4,  // 已停止（人工中断）
  TIMEOUT:  5   // 测试超时
};

const TEST_STATUS_TEXT = {
  [TEST_STATUS.IDLE]:    '空闲',
  [TEST_STATUS.RUNNING]: '测试中',
  [TEST_STATUS.PASS]:    '通过',
  [TEST_STATUS.FAIL]:    '失败',
  [TEST_STATUS.ABORTED]: '已停止',
  [TEST_STATUS.TIMEOUT]: '超时'
};

// ============================================================
// 5. 单项自检结果码 (SINGLE_RESULT)
// ============================================================

/**
 * BLOCK_TEST_STATUS.SINGLE_RESULT_BASE (0x8010-0x8018) 的结果码
 * 每个测试项独立上报结果，共 9 项（对应 ATE_MASK bit0-bit8）
 */
const SINGLE_RESULT = {
  PENDING:   0,  // 待测试
  TESTING:   1,  // 测试中
  PASS:      2,  // 通过
  FAIL:      3,  // 失败
  SKIP:      4,  // 跳过（未选择或不适用）
  TIMEOUT:   5   // 超时
};

const SINGLE_RESULT_TEXT = {
  [SINGLE_RESULT.PENDING]: '待测',
  [SINGLE_RESULT.TESTING]: '测试中',
  [SINGLE_RESULT.PASS]:    '通过',
  [SINGLE_RESULT.FAIL]:    '失败',
  [SINGLE_RESULT.SKIP]:    '跳过',
  [SINGLE_RESULT.TIMEOUT]: '超时'
};

const SINGLE_RESULT_CSS_CLASS = {
  [SINGLE_RESULT.PENDING]: 'result-pending',
  [SINGLE_RESULT.TESTING]: 'result-testing',
  [SINGLE_RESULT.PASS]:    'result-pass',
  [SINGLE_RESULT.FAIL]:    'result-fail',
  [SINGLE_RESULT.SKIP]:    'result-skip',
  [SINGLE_RESULT.TIMEOUT]: 'result-timeout'
};

// ============================================================
// 6. ATE 自检项故障错误码 (ERROR_CODE)
// ============================================================

/**
 * BLOCK_TEST_STATUS.ERROR_CODE_BASE (0x8020-0x8028) 的错误码
 * 每个错误码绑定中文原因、排障建议和可能涉及的硬件点位
 * 依据 P0 方案第 3.7.3 节定义，共 9 项（对应 ATE_MASK bit0-bit8）
 */
const ERROR_CODE = {
  // SPI Flash 错误码
  SPIFLASH_INIT_FAIL:     0x0010,  // SPI Flash 初始化失败
  SPIFLASH_READ_FAIL:     0x0011,  // SPI Flash 读取失败
  SPIFLASH_WRITE_FAIL:    0x0012,  // SPI Flash 写入失败
  SPIFLASH_ERASE_FAIL:    0x0013,  // SPI Flash 擦除失败
  SPIFLASH_VERIFY_FAIL:   0x0014,  // SPI Flash 校验失败

  // EEPROM 错误码
  EEPROM_INIT_FAIL:       0x0020,  // EEPROM 初始化失败
  EEPROM_READ_FAIL:       0x0021,  // EEPROM 读取失败
  EEPROM_WRITE_FAIL:      0x0022,  // EEPROM 写入失败
  EEPROM_VERIFY_FAIL:     0x0023,  // EEPROM 校验失败

  // RTC 错误码
  RTC_INIT_FAIL:          0x0030,  // RTC 初始化失败
  RTC_COUNT_FAIL:         0x0031,  // RTC 计数未递增
  RTC_BACKUP_FAIL:        0x0032,  // RTC 备份电池异常

  // RS485-1 错误码
  RS485_1_INIT_FAIL:      0x0040,  // RS485-1 初始化失败
  RS485_1_TX_FAIL:        0x0041,  // RS485-1 发送失败
  RS485_1_RX_FAIL:        0x0042,  // RS485-1 接收失败
  RS485_1_TIMEOUT:        0x0043,  // RS485-1 超时

  // RS485-2 错误码
  RS485_2_INIT_FAIL:      0x0050,  // RS485-2 初始化失败
  RS485_2_TX_FAIL:        0x0051,  // RS485-2 发送失败
  RS485_2_RX_FAIL:        0x0052,  // RS485-2 接收失败
  RS485_2_TIMEOUT:        0x0053,  // RS485-2 超时

  // CAN/扩展板错误码
  CAN_INIT_FAIL:          0x0060,  // CAN 初始化失败
  CAN_TX_FAIL:            0x0061,  // CAN 发送失败
  CAN_RX_FAIL:            0x0062,  // CAN 接收失败
  CAN_TIMEOUT:            0x0063,  // CAN 超时
  AUX_BOARD_FAIL:         0x0064,  // 辅助板连接失败

  // ADC/AO 错误码
  ADC_INIT_FAIL:          0x0070,  // ADC 初始化失败
  ADC_READ_FAIL:          0x0071,  // ADC 读取失败
  ADC_VERIFY_FAIL:        0x0072,  // ADC 校验失败（期望值与实际值偏差超限）
  AO_OUTPUT_FAIL:         0x0073,  // AO 输出失败

  // 继电器错误码
  RELAY_INIT_FAIL:        0x0080,  // 继电器初始化失败
  RELAY_CTRL_FAIL:        0x0081,  // 继电器控制失败
  RELAY_READ_FAIL:        0x0082,  // 继电器回读失败
  RELAY_STUCK:            0x0083,  // 继电器卡死

  // RS485 热切换错误码
  HOTSWAP_INIT_FAIL:      0x0090,  // 热切换初始化失败
  HOTSWAP_SWITCH_FAIL:    0x0091,  // 热切换切换失败
  HOTSWAP_RECOVERY_FAIL:  0x0092,  // 热切换恢复失败

  // 传感器测试错误码 (P1)
  SENSOR_READ_FAIL:         0x00A0,  // 传感器数据读取失败
  SENSOR_TIMEOUT:           0x00A1,  // 传感器通信超时
  SENSOR_ER_READ:           0x00A2,  // ErRead 连续通信失败触发
  SENSOR_ER_MAX:            0x00A3,  // ErMax 数值不变触发
  SENSOR_DEVIATION剔除:     0x00A4,  // 偏差剔除离群值
  SENSOR_VALUE_MISMATCH:    0x00A5,  // 传感器值与模拟器预设不匹配
  SENSOR_ACTUAL_MISMATCH:   0x00A6,  // ActualTemp/ActualHumi 平均值不匹配
  SENSOR_HISTORY_MISMATCH:  0x00A7,  // 历史缓冲值不匹配
  SENSOR_BOOT_FALLBACK_FAIL:0x00A8,  // 启动回退验证失败
  SENSOR_TIME_SYNC_FAIL:    0x00A9,  // 对时失败
  SENSOR_REBOOT_FAIL:       0x00AA,  // 设备重启失败
  SENSOR_RECONNECT_FAIL:    0x00AB,  // 重启后重连失败
  SENSOR_CONFIG_WRITE_FAIL: 0x00AC,  // 配置写入失败
  SENSOR_CONFIG_VERIFY_FAIL:0x00AD,  // 配置回读验证失败
  SENSOR_ALARM_MISMATCH:    0x00AE,  // 告警状态不匹配
  SENSOR_HISTORY_CLEAR_FAIL:0x00AF,  // 历史缓冲清空失败
};

/**
 * 错误码详情映射：错误码 -> { 中文原因, 排障建议, 可能硬件点位 }
 * 用于前端 Fail 弹窗、报告和日志
 */
const ERROR_CODE_DETAIL = {
  [ERROR_CODE.SPIFLASH_INIT_FAIL]: {
    name: 'SPI Flash 初始化失败',
    cause: 'SPI 外设时钟未使能、GPIO 配置错误或 Flash 芯片未上电',
    suggestion: '检查 SPI 总线连接、Flash 供电电压（2.85V~3.6V）、片选引脚配置',
    hardware: 'SPI Flash 芯片 (W25Qxx)'
  },
  [ERROR_CODE.SPIFLASH_READ_FAIL]: {
    name: 'SPI Flash 读取失败',
    cause: 'SPI 通信时序异常、CRC 校验错误或 Flash 芯片损坏',
    suggestion: '用示波器检查 SPI 时钟和数据波形，尝试更换 Flash 芯片',
    hardware: 'SPI Flash 芯片 (W25Qxx)'
  },
  [ERROR_CODE.SPIFLASH_WRITE_FAIL]: {
    name: 'SPI Flash 写入失败',
    cause: '写保护使能、页编程超时或 Flash 芯片损坏',
    suggestion: '检查写保护引脚状态，确认 Flash 芯片未损坏',
    hardware: 'SPI Flash 芯片 (W25Qxx)'
  },
  [ERROR_CODE.SPIFLASH_ERASE_FAIL]: {
    name: 'SPI Flash 擦除失败',
    cause: '扇区保护使能、擦除超时或 Flash 芯片损坏',
    suggestion: '检查扇区保护状态，尝试全片擦除',
    hardware: 'SPI Flash 芯片 (W25Qxx)'
  },
  [ERROR_CODE.SPIFLASH_VERIFY_FAIL]: {
    name: 'SPI Flash 校验失败',
    cause: '读回数据与写入数据不一致，可能为 Flash 芯片损坏或通信干扰',
    suggestion: '重复写入-读取-校验流程，必要时更换 Flash 芯片',
    hardware: 'SPI Flash 芯片 (W25Qxx)'
  },
  [ERROR_CODE.EEPROM_INIT_FAIL]: {
    name: 'EEPROM 初始化失败',
    cause: 'I2C 总线未就绪、地址冲突或 EEPROM 芯片未响应',
    suggestion: '检查 I2C 上拉电阻、确认从机地址正确',
    hardware: 'EEPROM 芯片 (AT24Cxx)'
  },
  [ERROR_CODE.EEPROM_READ_FAIL]: {
    name: 'EEPROM 读取失败',
    cause: 'I2C 通信超时、NACK 响应或 EEPROM 芯片损坏',
    suggestion: '检查 I2C 波形，确认从机地址和页地址',
    hardware: 'EEPROM 芯片 (AT24Cxx)'
  },
  [ERROR_CODE.EEPROM_WRITE_FAIL]: {
    name: 'EEPROM 写入失败',
    cause: 'I2C 写保护使能、页编程超时或 EEPROM 芯片损坏',
    suggestion: '检查写保护引脚，确认写入地址在有效范围内',
    hardware: 'EEPROM 芯片 (AT24Cxx)'
  },
  [ERROR_CODE.EEPROM_VERIFY_FAIL]: {
    name: 'EEPROM 校验失败',
    cause: '读回数据与写入数据不一致',
    suggestion: '重复写入-读取-校验流程，必要时更换 EEPROM 芯片',
    hardware: 'EEPROM 芯片 (AT24Cxx)'
  },
  [ERROR_CODE.RTC_INIT_FAIL]: {
    name: 'RTC 初始化失败',
    cause: 'RTC 外设时钟未使能、I2C 地址错误或 RTC 芯片未上电',
    suggestion: '检查 RTC 供电（32.768kHz 晶振）、I2C 连接',
    hardware: 'RTC 芯片 (PCF8563/BQ32000)'
  },
  [ERROR_CODE.RTC_COUNT_FAIL]: {
    name: 'RTC 计数未递增',
    cause: 'RTC 内部时钟树配置错误或分频寄存器异常',
    suggestion: '检查 32.768kHz 晶振是否起振，确认分频寄存器配置',
    hardware: 'RTC 芯片 (PCF8563/BQ32000)'
  },
  [ERROR_CODE.RTC_BACKUP_FAIL]: {
    name: 'RTC 备份电池异常',
    cause: '备份电池电压过低或电池连接断开',
    suggestion: '更换 CR2032 纽扣电池，检查电池座连接',
    hardware: 'CR2032 电池座'
  },
  [ERROR_CODE.RS485_1_INIT_FAIL]: {
    name: 'RS485-1 初始化失败',
    cause: 'UART 配置错误、收发器芯片未使能或 GPIO 配置异常',
    suggestion: '检查 RS485 收发器 DE/RE 引脚配置、波特率设置',
    hardware: 'RS485-1 收发器 (SP3485/MAX485)'
  },
  [ERROR_CODE.RS485_1_TX_FAIL]: {
    name: 'RS485-1 发送失败',
    cause: '发送缓冲区溢出、总线冲突或收发器芯片损坏',
    suggestion: '检查总线终端电阻（120Ω）、确认收发器芯片供电',
    hardware: 'RS485-1 收发器 (SP3485/MAX485)'
  },
  [ERROR_CODE.RS485_1_RX_FAIL]: {
    name: 'RS485-1 接收失败',
    cause: '收发器芯片损坏、总线断开或波特率不匹配',
    suggestion: '检查总线连接、确认从站波特率和站号',
    hardware: 'RS485-1 收发器 (SP3485/MAX485)'
  },
  [ERROR_CODE.RS485_1_TIMEOUT]: {
    name: 'RS485-1 超时',
    cause: '从站未响应、总线冲突或通信参数错误',
    suggestion: '检查从站是否上电、确认波特率和站号',
    hardware: 'RS485-1 总线'
  },
  [ERROR_CODE.RS485_2_INIT_FAIL]: {
    name: 'RS485-2 初始化失败',
    cause: 'UART 配置错误、收发器芯片未使能或 GPIO 配置异常',
    suggestion: '检查 RS485 收发器 DE/RE 引脚配置、波特率设置',
    hardware: 'RS485-2 收发器 (SP3485/MAX485)'
  },
  [ERROR_CODE.RS485_2_TX_FAIL]: {
    name: 'RS485-2 发送失败',
    cause: '发送缓冲区溢出、总线冲突或收发器芯片损坏',
    suggestion: '检查总线终端电阻（120Ω）、确认收发器芯片供电',
    hardware: 'RS485-2 收发器 (SP3485/MAX485)'
  },
  [ERROR_CODE.RS485_2_RX_FAIL]: {
    name: 'RS485-2 接收失败',
    cause: '收发器芯片损坏、总线断开或波特率不匹配',
    suggestion: '检查总线连接、确认从站波特率和站号',
    hardware: 'RS485-2 收发器 (SP3485/MAX485)'
  },
  [ERROR_CODE.RS485_2_TIMEOUT]: {
    name: 'RS485-2 超时',
    cause: '从站未响应、总线冲突或通信参数错误',
    suggestion: '检查从站是否上电、确认波特率和站号',
    hardware: 'RS485-2 总线'
  },
  [ERROR_CODE.CAN_INIT_FAIL]: {
    name: 'CAN 初始化失败',
    cause: 'CAN 外设时钟未使能、波特率配置错误或收发器芯片未使能',
    suggestion: '检查 CAN 收发器芯片供电、确认波特率配置',
    hardware: 'CAN 收发器 (TJA1050/ISO1050)'
  },
  [ERROR_CODE.CAN_TX_FAIL]: {
    name: 'CAN 发送失败',
    cause: '发送缓冲区满、总线关闭或收发器芯片损坏',
    suggestion: '检查总线终端电阻（120Ω）、确认收发器芯片供电',
    hardware: 'CAN 收发器 (TJA1050/ISO1050)'
  },
  [ERROR_CODE.CAN_RX_FAIL]: {
    name: 'CAN 接收失败',
    cause: '收发器芯片损坏、总线断开或波特率不匹配',
    suggestion: '检查总线连接、确认从节点波特率',
    hardware: 'CAN 收发器 (TJA1050/ISO1050)'
  },
  [ERROR_CODE.CAN_TIMEOUT]: {
    name: 'CAN 超时',
    cause: '从节点未响应、总线冲突或通信参数错误',
    suggestion: '检查从节点是否上电、确认波特率和节点 ID',
    hardware: 'CAN 总线'
  },
  [ERROR_CODE.AUX_BOARD_FAIL]: {
    name: '辅助板连接失败',
    cause: '辅助板未上电、Modbus RTU 地址错误或通信参数不匹配',
    suggestion: '检查辅助板供电、确认从站地址和波特率',
    hardware: '辅助 DI 扩展板'
  },
  [ERROR_CODE.ADC_INIT_FAIL]: {
    name: 'ADC 初始化失败',
    cause: 'ADC 外设时钟未使能、采样通道配置错误或参考电压异常',
    suggestion: '检查 ADC 参考电压（2.5V/3.3V）、确认采样通道配置',
    hardware: 'ADC 参考电压源'
  },
  [ERROR_CODE.ADC_READ_FAIL]: {
    name: 'ADC 读取失败',
    cause: 'ADC 转换超时、DMA 传输错误或硬件故障',
    suggestion: '检查 ADC 输入滤波电路、确认 DMA 配置',
    hardware: 'ADC 输入通道'
  },
  [ERROR_CODE.ADC_VERIFY_FAIL]: {
    name: 'ADC 校验失败',
    cause: '期望值与实际值偏差超限，可能为 ADC 精度不足或输入电路故障',
    suggestion: '用万用表测量 ADC 输入电压，确认是否在容差范围内',
    hardware: 'ADC 输入通道、AO-ADC 短接线'
  },
  [ERROR_CODE.AO_OUTPUT_FAIL]: {
    name: 'AO 输出失败',
    cause: 'AO DAC 配置错误、输出缓冲电路故障或负载异常',
    suggestion: '用万用表测量 AO 输出电压，检查负载连接',
    hardware: 'AO 输出通道 (DAC)'
  },
  [ERROR_CODE.RELAY_INIT_FAIL]: {
    name: '继电器初始化失败',
    cause: '继电器驱动电路异常、GPIO 配置错误或电源不足',
    suggestion: '检查继电器驱动电路供电（12V/24V）、确认 GPIO 输出配置',
    hardware: '继电器驱动电路'
  },
  [ERROR_CODE.RELAY_CTRL_FAIL]: {
    name: '继电器控制失败',
    cause: '继电器驱动电路故障、线圈断路或电源不足',
    suggestion: '检查继电器线圈电阻、确认驱动电路供电',
    hardware: '继电器模块'
  },
  [ERROR_CODE.RELAY_READ_FAIL]: {
    name: '继电器回读失败',
    cause: '反馈电路故障、光耦损坏或 GPIO 输入异常',
    suggestion: '检查继电器反馈光耦、确认 GPIO 输入配置',
    hardware: '继电器反馈电路'
  },
  [ERROR_CODE.RELAY_STUCK]: {
    name: '继电器卡死',
    cause: '继电器触点粘连、机械卡死或线圈断路',
    suggestion: '更换继电器模块，检查机械结构',
    hardware: '继电器模块'
  },
  [ERROR_CODE.HOTSWAP_INIT_FAIL]: {
    name: 'RS485 热切换初始化失败',
    cause: '切换电路配置错误、GPIO 驱动异常',
    suggestion: '检查热切换电路 GPIO 配置、确认切换芯片供电',
    hardware: 'RS485 热切换电路'
  },
  [ERROR_CODE.HOTSWAP_SWITCH_FAIL]: {
    name: 'RS485 热切换切换失败',
    cause: '切换电路故障、总线冲突',
    suggestion: '检查切换电路响应时间，确认无总线冲突',
    hardware: 'RS485 热切换电路'
  },
  [ERROR_CODE.HOTSWAP_RECOVERY_FAIL]: {
    name: 'RS485 热切换恢复失败',
    cause: '恢复电路故障、无法恢复默认状态',
    suggestion: '检查恢复电路、确认硬件连接',
    hardware: 'RS485 热切换电路'
  },

  // 传感器测试错误详情 (P1)
  [ERROR_CODE.SENSOR_READ_FAIL]: {
    name: '传感器数据读取失败',
    cause: 'Modbus TCP 读取环控器传感器寄存器失败',
    suggestion: '检查 Modbus TCP 连接、确认寄存器地址正确',
    hardware: '环控器 Modbus TCP'
  },
  [ERROR_CODE.SENSOR_TIMEOUT]: {
    name: '传感器通信超时',
    cause: '环控器 RS485 轮询传感器超时或模拟器未响应',
    suggestion: '检查 USB-RS485 连接、确认模拟器从站地址和波特率',
    hardware: 'RS485 总线、传感器模拟器'
  },
  [ERROR_CODE.SENSOR_ER_READ]: {
    name: 'ErRead 连续通信失败',
    cause: '传感器连续 10 次通信失败触发 ErRead 异常',
    suggestion: '检查模拟器超时注入是否正确、确认轮询周期',
    hardware: 'RS485 总线'
  },
  [ERROR_CODE.SENSOR_ER_MAX]: {
    name: 'ErMax 数值不变异常',
    cause: '传感器连续 100 次读数不变触发 ErMax 异常',
    suggestion: '确认模拟器固定值注入次数、检查轮询周期',
    hardware: '传感器模拟器'
  },
  [ERROR_CODE.SENSOR_DEVIATION剔除]: {
    name: '偏差剔除离群值',
    cause: '传感器读数偏离中位数超过 ±10℃ 阈值被剔除',
    suggestion: '检查离群值注入是否正确、确认中位数算法',
    hardware: '环控器固件'
  },
  [ERROR_CODE.SENSOR_VALUE_MISMATCH]: {
    name: '传感器值不匹配',
    cause: '环控器读取的传感器值与模拟器预设值不一致',
    suggestion: '检查影子寄存器值、确认换算规则（val/10）、确认场区地址映射',
    hardware: '传感器模拟器、环控器'
  },
  [ERROR_CODE.SENSOR_ACTUAL_MISMATCH]: {
    name: '平均值不匹配',
    cause: 'ActualTemp/ActualHumi 与期望平均值偏差超限',
    suggestion: '确认参与计算的传感器路数、检查未安装屏蔽逻辑',
    hardware: '环控器固件'
  },
  [ERROR_CODE.SENSOR_HISTORY_MISMATCH]: {
    name: '历史缓冲值不匹配',
    cause: '历史缓冲中的温湿度值与冻结阶段预设值不一致',
    suggestion: '检查跨小时冻结是否成功、确认对时跳变未污染缓冲区',
    hardware: '环控器 FlashDB'
  },
  [ERROR_CODE.SENSOR_BOOT_FALLBACK_FAIL]: {
    name: '启动回退验证失败',
    cause: '重启后 ActualTemp/ActualHumi 未回退到对应历史值',
    suggestion: '确认传感器异常保持（persist=true）、检查 find_current_hour_data 匹配',
    hardware: '环控器固件'
  },
  [ERROR_CODE.SENSOR_TIME_SYNC_FAIL]: {
    name: '对时失败',
    cause: 'Modbus TCP 写入 HR10~HR17 后 HR17 非 0 或读回时间不一致',
    suggestion: '检查 HR10~HR17 寄存器是否可写、确认固件对时逻辑',
    hardware: '环控器 Modbus TCP'
  },
  [ERROR_CODE.SENSOR_REBOOT_FAIL]: {
    name: '设备重启失败',
    cause: '写入 HR18=0x55AA 后设备未重启或重启指令被拒绝',
    suggestion: '检查 HR18 寄存器是否可写、确认重启魔数值',
    hardware: '环控器 Modbus TCP'
  },
  [ERROR_CODE.SENSOR_RECONNECT_FAIL]: {
    name: '重启后重连失败',
    cause: '设备重启后 Modbus TCP 重连超时',
    suggestion: '增加 rebootTimeoutMs、检查网络连接、确认设备 IP',
    hardware: '网络、环控器'
  },
  [ERROR_CODE.SENSOR_CONFIG_WRITE_FAIL]: {
    name: '配置写入失败',
    cause: '写入传感器配置寄存器（安装位/阈值/补偿）失败',
    suggestion: '检查寄存器地址和写入权限、确认 Modbus TCP 连接',
    hardware: '环控器 Modbus TCP'
  },
  [ERROR_CODE.SENSOR_CONFIG_VERIFY_FAIL]: {
    name: '配置回读验证失败',
    cause: '写入配置后回读值与写入值不一致',
    suggestion: '确认寄存器可写性、检查是否需要重启生效',
    hardware: '环控器 Modbus TCP'
  },
  [ERROR_CODE.SENSOR_ALARM_MISMATCH]: {
    name: '告警状态不匹配',
    cause: '超阈值后告警标志未置位或恢复后告警未清除',
    suggestion: '检查告警寄存器地址、确认告警恢复延时策略',
    hardware: '环控器固件'
  },
  [ERROR_CODE.SENSOR_HISTORY_CLEAR_FAIL]: {
    name: '历史缓冲清空失败',
    cause: '调用清空接口后历史缓冲仍有旧数据',
    suggestion: '确认 MSH sensor_history_clear 或调试寄存器可用',
    hardware: '环控器固件'
  }
};

// ============================================================
// 7. ATE TCP+JSON 帧协议常量 (0x55AA)
// ============================================================

/**
 * ATE TCP+JSON 帧协议常量
 * 帧格式：Magic(2) + CmdType(2) + Length(2) + JSON Payload
 * 依据 P0 方案第 4 章定义
 */
const ATE_FRAME = {
  MAGIC: 0x55AA,           // 帧头魔数
  MAGIC_BYTES: Buffer.from([0x55, 0xAA]),  // 帧头字节序：0x55, 0xAA
  HEADER_SIZE: 6,          // 帧头大小：Magic(2) + CmdType(2) + Length(2)
  MAX_JSON_SIZE: 16384     // 最大 JSON 负载大小（16KB）
};

/**
 * ATE TCP+JSON 命令类型 (CmdType)
 * 用于区分不同类型的请求和响应
 */
const ATE_CMD = {
  // 下行命令（上位机 -> 固件）
  DOWNLINK:    0x0001,  // 下行命令
  UPLINK:      0x0002,  // 上行响应
  ACK:         0x0003,  // 确认应答
  NACK:        0x0004,  // 否定应答
  HEARTBEAT:   0x0005,  // 心跳包
  REPORT:      0x0006,  // 状态上报（固件主动上报）
  ERROR:       0x0007   // 错误响应
};

/**
 * ATE JSON 消息类型 (method 字段)
 * 用于 JSON Payload 内部的消息路由
 */
const ATE_METHOD = {
  // 控制命令
  TEST_ENTER:      'test.enter',       // 进入测试模式
  TEST_EXIT:       'test.exit',        // 退出测试模式
  TEST_START:      'test.start',       // 开始测试
  TEST_STOP:       'test.stop',        // 停止测试
  TEST_RESET:      'test.reset',       // 复位测试状态
  TEST_PROGRESS:   'test.progress',    // 测试进度查询

  // 属性操作
  PROPERTIES_GET:  'properties.get',   // 批量读取属性
  PROPERTIES_SET:  'properties.set',   // 批量写入属性
  CONFIG_WRITE:    'config.write',     // 写入配置参数

  // 控制操作
  CONTROL_FORCE_IO: 'control.force_io', // 强制 IO 输出

  // 心跳
  HEARTBEAT:       'heartbeat',        // 心跳包

  // 状态上报
  REPORT:          'report',           // 500ms 状态上报
};

// ============================================================
// 8. WebSocket 消息类型
// ============================================================

/**
 * 前端到后端的 WebSocket 消息类型
 */
const WS_MSG_TYPE = {
  // ATE 测试控制
  START_TEST_REQUEST:     'start_test_request',
  STOP_TEST_REQUEST:      'stop_test_request',
  RESET_TEST_REQUEST:     'reset_test_request',
  RETRY_FAILED_REQUEST:   'retry_failed_request',
  MANUAL_FORCE_IO_REQUEST: 'manual_force_io_request',
  GET_TEST_SESSION:       'get_test_session',

  // 设备管理
  GET_DEVICES:            'get_devices',
  RELAY_CONTROL:          'relay_control',
  OTA_START:              'ota_start',
};

/**
 * 后端到前端的 WebSocket 消息类型
 */
const WS_MSG_TYPE_SERVER = {
  // ATE 测试状态
  TEST_PROGRESS_UPDATE:   'test_progress_update',
  TEST_FINISHED:          'test_finished_notification',
  TEST_ERROR:             'test_error',

  // ATE 日志
  ATE_DEVICE_LOG:         'ate_device_log',
  ATE_RAW_FRAME:          'ate_raw_frame',

  // 设备状态
  DEVICE_STATUS:          'device_status',
  SENSOR_DATA:            'sensor_data',
  RELAY_STATUS:           'relay_status',
  OTA_PROGRESS:           'ota_progress',
};

// ============================================================
// 9. HTTP API 路径定义
// ============================================================

const API_PATH = {
  TEST_REPORTS:     '/api/test/reports',
  TEST_REPORT_JSON: '/api/test/reports/:id.json',
  TEST_REPORT_HTML: '/api/test/reports/:id.html',
  TEST_CONFIG:      '/api/test/config',
  DEVICES:          '/api/devices',
  OTA_DOWNLOAD:     '/api/ota/download'
};

// ============================================================
// 10. 环境变量与配置项默认值
// ============================================================

const CONFIG_DEFAULTS = {
  DEVICE_IP:            '192.168.10.233',
  LOCAL_IP:             'auto',
  ATE_TCP_PORT:         9001,
  MODBUS_PORT:          502,
  REPORT_DIR:           'backend/reports',
  ATE_ACK_TIMEOUT_MS:   2000,
  ATE_RECONNECT_COOLDOWN_MS: 12000,
  ATE_POLL_INTERVAL_MS: 2000,
  ATE_REPORT_INTERVAL_MS: 500,
};

// ============================================================
// 11. 导出
// ============================================================

module.exports = {
  // 寄存器区块
  BLOCK_TEST_STATUS,
  ATE_TEST_BLOCK_SIZE,
  BLOCK_TEST_CONFIG,
  BLOCK_ENV,
  BLOCK_HW,
  BLOCK_SENSOR_CONFIG,
  SENSOR_ACTUAL,
  BLOCK_SENSOR_TIME,
  INVALID_VALUE,
  BLOCK_SENSOR_ALARM,
  BLOCK_SENSOR_THRESHOLD,
  BLOCK_SENSOR_COMPENSATION,

  // 测试掩码
  ATE_MASK_ALL,
  ATE_MASK,

  // 测试控制命令
  TEST_CMD,

  // 整体测试状态码
  TEST_STATUS,
  TEST_STATUS_TEXT,

  // 单项自检结果码
  SINGLE_RESULT,
  SINGLE_RESULT_TEXT,
  SINGLE_RESULT_CSS_CLASS,

  // 错误码
  ERROR_CODE,
  ERROR_CODE_DETAIL,

  // ATE TCP+JSON 帧协议
  ATE_FRAME,
  ATE_CMD,
  ATE_METHOD,

  // WebSocket 消息类型
  WS_MSG_TYPE,
  WS_MSG_TYPE_SERVER,

  // HTTP API 路径
  API_PATH,

  // 配置默认值
  CONFIG_DEFAULTS,
};
