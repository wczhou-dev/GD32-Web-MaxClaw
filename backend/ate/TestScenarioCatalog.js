/**
 * backend/ate/TestScenarioCatalog.js
 * P1 传感器测试场景目录
 *
 * 职责：
 *   1. 定义全部 P1 传感器测试场景（20 项 + 历史回退专项）
 *   2. 每个场景包含：模拟器输入、期望输出、断言规则、清理动作
 *   3. 为 TestManager 提供场景加载和查询接口
 *
 * 开发依据：
 *   - 传感器自动测试内容开发清单P1.md（v2.6）
 *   - 传感器自动测试任务开发列表P1.md（v2.2）
 *
 * 更新历史：
 *   v1.0  2026-06-16  初始版本，覆盖 P1 全量场景
 */

'use strict';

/**
 * 场景类型枚举
 */
const SCENARIO_TYPE = {
  NORMAL_READ: 'normal-read',
  ABNORMAL_FILTER: 'abnormal-filter',
  HISTORY_BOOT_FALLBACK: 'history-boot-fallback',
  CONFIG_HOT_UPDATE: 'config-hot-update',
  COMPOSITE: 'composite',
};

/**
 * 场景分类枚举
 */
const SCENARIO_CATEGORY = {
  READ: '正常抄读',
  ABNF: '异常过滤',
  HIST: '历史回退',
  HOT: '配置热更新',
  COMP: '综合场景',
};

// ============================================================
// 页面分组枚举（对应 §1.5.1）
// ============================================================

const PAGE_GROUP = {
  PRE_CHECK: '前置检查',
  READ: '正常抄读',
  ABNF: '异常过滤',
  HIST: '历史回退',
  HOT: '配置热更新',
  COMP: '综合场景',
};

// ============================================================
// 显示 ID → 真实场景 ID 映射（§1.5.4 子场景拆分）
// ============================================================

const ID_ALIAS_MAP = {
  'T-ABNF-003-A': 'T-ABNF-003-ODD',
  'T-ABNF-003-B': 'T-ABNF-003-EVEN',
  'T-HIST-001-A': 'T-HIST-001',
  'T-HIST-001-B': 'SEN-HIST-BOOT-001',
};

// 反向映射：真实 ID → 显示 ID
const ID_REVERSE_MAP = {};
for (const [displayId, realId] of Object.entries(ID_ALIAS_MAP)) {
  if (!ID_REVERSE_MAP[realId]) ID_REVERSE_MAP[realId] = displayId;
}

/**
 * 解析场景 ID（支持显示 ID 和真实 ID）
 * @param {string} id 显示 ID 或真实 ID
 * @returns {string} 真实场景 ID
 */
function resolveScenarioId(id) {
  return ID_ALIAS_MAP[id] || id;
}

// ============================================================
// P1 全量场景定义
// ============================================================

const scenarios = [
  // ----------------------------------------------------------
  // 前置检查 (3 项，不计入 P1 正式 20 项)
  // ----------------------------------------------------------
  {
    id: 'PRE-FIELD-001',
    testId: 'PRE-FIELD-001',
    scenarioId: 'PRE-FIELD-001',
    name: '场区类型读取与地址表加载',
    type: 'pre-check',
    category: '前置检查',
    group: PAGE_GROUP.PRE_CHECK,
    priority: 'P0',
    isP1Required: false,
    estimatedSeconds: 5,
    dependencies: [],
    timeoutMs: 10000,
    description: '读取环控器场区类型寄存器 0x0019，加载对应传感器地址表',
    inputs: { register: 0x0019, count: 1 },
    expected: { nonZero: true },
    assertions: [{ type: '场区非零', rule: 'field_zone_non_zero' }],
    cleanup: [],
  },
  {
    id: 'PRE-INSTALL-001',
    testId: 'PRE-INSTALL-001',
    scenarioId: 'PRE-INSTALL-001',
    name: '传感器安装状态读取',
    type: 'pre-check',
    category: '前置检查',
    group: PAGE_GROUP.PRE_CHECK,
    priority: 'P0',
    isP1Required: false,
    estimatedSeconds: 5,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 10000,
    description: '读取 0x700A~0x700F 确认传感器安装位，生成 installed 位图',
    inputs: { register: 0x700A, count: 6 },
    expected: { bitmapParsed: true },
    assertions: [{ type: '位图解析', rule: 'install_bitmap_parsed' }],
    cleanup: [],
  },
  {
    id: 'PRE-ENV-001',
    testId: 'PRE-ENV-001',
    scenarioId: 'PRE-ENV-001',
    name: '环控器传感器数据块读取',
    type: 'pre-check',
    category: '前置检查',
    group: PAGE_GROUP.PRE_CHECK,
    priority: 'P0',
    isP1Required: false,
    estimatedSeconds: 5,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 10000,
    description: '读取 BLOCK_ENV (0x1001~0x1048) 验证数据结构完整',
    inputs: { register: 0x1001, count: 72 },
    expected: { dataComplete: true },
    assertions: [{ type: '数据完整', rule: 'block_env_complete' }],
    cleanup: [],
  },

  // ----------------------------------------------------------
  // 正常抄读 (4 项)
  // ----------------------------------------------------------
  {
    id: 'T-READ-001',
    testId: 'T-READ-001',
    scenarioId: 'SEN-READ-TEMP-001',
    name: '室内温度传感器抄读',
    type: SCENARIO_TYPE.NORMAL_READ,
    category: SCENARIO_CATEGORY.READ,
    group: PAGE_GROUP.READ,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 30,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 30000,
    description: '验证 16 路室内温度逐路采集和 ActualTemp 平均值计算',
    inputs: {
      sensors: Array.from({ length: 16 }, (_, i) => ({
        key: `temp_${i + 1}`,
        value: 20.0 + i * 1.0,  // 20.0~35.0℃
        unit: 'C',
        scale: 10,
      })),
    },
    expected: {
      registerBlock: { start: 0x1001, count: 32 },  // 温度在奇数位
      actualRegister: 0x103B,
      convertRule: 'int16_val_div_10',
      tolerance: 0.1,
    },
    assertions: [
      { type: '逐路温度', rule: 'each_temp_matches_simulator', tolerance: 0.1 },
      { type: 'ActualTemp', rule: 'actual_temp_equals_average', tolerance: 0.1 },
    ],
    cleanup: ['restoreDefaultSensors', 'clearFaults'],
  },
  {
    id: 'T-READ-002',
    testId: 'T-READ-002',
    scenarioId: 'SEN-READ-HUMI-001',
    name: '室内湿度传感器抄读',
    type: SCENARIO_TYPE.NORMAL_READ,
    category: SCENARIO_CATEGORY.READ,
    group: PAGE_GROUP.READ,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 30,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 30000,
    description: '验证 16 路室内湿度逐路采集和 ActualHumi 平均值计算',
    inputs: {
      sensors: Array.from({ length: 16 }, (_, i) => ({
        key: `humi_${i + 1}`,
        value: 40.0 + i * 2.0,  // 40.0~70.0%RH
        unit: '%RH',
        scale: 10,
      })),
    },
    expected: {
      registerBlock: { start: 0x1001, count: 32 },  // 湿度在偶数位
      actualRegister: 0x103C,
      convertRule: 'uint16_val_div_10',
      tolerance: 0.5,
    },
    assertions: [
      { type: '逐路湿度', rule: 'each_humi_matches_simulator', tolerance: 0.5 },
      { type: 'ActualHumi', rule: 'actual_humi_equals_average', tolerance: 0.5 },
    ],
    cleanup: ['restoreDefaultSensors', 'clearFaults'],
  },
  {
    id: 'T-READ-003',
    testId: 'T-READ-003',
    scenarioId: 'SEN-READ-PRESS-001',
    name: '压差传感器抄读',
    type: SCENARIO_TYPE.NORMAL_READ,
    category: SCENARIO_CATEGORY.READ,
    group: PAGE_GROUP.READ,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 20,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 20000,
    description: '验证 4 路室内压差采集',
    inputs: {
      sensors: [
        { key: 'press_1', value: 0, unit: 'Pa', scale: 10 },
        { key: 'press_2', value: 10, unit: 'Pa', scale: 10 },
        { key: 'press_3', value: 25, unit: 'Pa', scale: 10 },
        { key: 'press_4', value: 50, unit: 'Pa', scale: 10 },
      ],
    },
    expected: {
      registerBlock: { start: 0x1042, count: 4 },
      convertRule: 'int16_val_div_10',
      tolerance: 0.1,
    },
    assertions: [
      { type: '逐路压差', rule: 'each_press_matches_simulator', tolerance: 0.1 },
    ],
    cleanup: ['restoreDefaultSensors'],
  },
  {
    id: 'T-READ-004',
    testId: 'T-READ-004',
    scenarioId: 'SEN-READ-CO2-001',
    name: 'CO2 传感器抄读',
    type: SCENARIO_TYPE.NORMAL_READ,
    category: SCENARIO_CATEGORY.READ,
    group: PAGE_GROUP.READ,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 20,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 20000,
    description: '验证 8 路 CO2 浓度采集',
    inputs: {
      sensors: [
        { key: 'co2_1', value: 400, unit: 'ppm', scale: 1 },
        { key: 'co2_2', value: 600, unit: 'ppm', scale: 1 },
        { key: 'co2_3', value: 800, unit: 'ppm', scale: 1 },
        { key: 'co2_4', value: 1000, unit: 'ppm', scale: 1 },
        { key: 'co2_5', value: 1200, unit: 'ppm', scale: 1 },
        { key: 'co2_6', value: 500, unit: 'ppm', scale: 1 },
        { key: 'co2_7', value: 700, unit: 'ppm', scale: 1 },
        { key: 'co2_8', value: 900, unit: 'ppm', scale: 1 },
      ],
    },
    expected: {
      registerBlock: { start: 0x1021, count: 8 },
      convertRule: 'uint16_raw',
      tolerance: 0,
    },
    assertions: [
      { type: '逐路CO2', rule: 'each_co2_matches_simulator', tolerance: 0 },
    ],
    cleanup: ['restoreDefaultSensors'],
  },

  // ----------------------------------------------------------
  // 异常过滤 (3 项，T-ABNF-003 含奇数/偶数子场景)
  // ----------------------------------------------------------
  {
    id: 'T-ABNF-001',
    testId: 'T-ABNF-001',
    scenarioId: 'SEN-ABNF-ERREAD-001',
    name: '通信失败 ErRead 过滤',
    type: SCENARIO_TYPE.ABNORMAL_FILTER,
    category: SCENARIO_CATEGORY.ABNF,
    group: PAGE_GROUP.ABNF,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 90,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 120000,
    description: '验证连续 10 次通信失败后触发 ErRead、数据无效和在线位清除',
    inputs: {
      preCondition: { key: 'temp_1', value: 25.0, unit: 'C', scale: 10 },
      fault: { key: 'temp_1', type: 'timeout', persist: false },
      failThreshold: 10,
    },
    expected: {
      afterFail: {
        dataRegister: 0x1001,
        expectedValue: 'INVALID_VALUE',
        onlineBitCleared: true,
        erReadAlarmSet: true,
      },
    },
    assertions: [
      { type: '数据无效', rule: 'value_equals_invalid' },
      { type: 'ErRead 置位', rule: 'er_read_alarm_set' },
      { type: '在线位清除', rule: 'online_bit_cleared' },
    ],
    cleanup: ['clearFault:temp_1'],
  },
  {
    id: 'T-ABNF-002',
    testId: 'T-ABNF-002',
    scenarioId: 'SEN-ABNF-ERMAX-001',
    name: '数值不变 ErMax 过滤',
    type: SCENARIO_TYPE.ABNORMAL_FILTER,
    category: SCENARIO_CATEGORY.ABNF,
    group: PAGE_GROUP.ABNF,
    priority: 'P1',
    isP1Required: true,
    estimatedSeconds: 300,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 300000,
    description: '验证连续 100 次读数不变后触发 ErMax',
    inputs: {
      fixedValue: { key: 'temp_1', value: 25.0, unit: 'C', scale: 10, repeat: 100 },
    },
    expected: {
      invariantThreshold: 100,
      erMaxAlarmSet: true,
    },
    assertions: [
      { type: 'ErMax 置位', rule: 'er_max_alarm_set' },
    ],
    cleanup: ['clearFault:temp_1', 'restoreDynamicValue:temp_1'],
  },
  {
    id: 'T-ABNF-003-ODD',
    testId: 'T-ABNF-003-A',
    scenarioId: 'SEN-ABNF-OUTLIER-ODD-001',
    parentTestId: 'T-ABNF-003',
    name: '奇数路温度偏差剔除',
    type: SCENARIO_TYPE.ABNORMAL_FILTER,
    category: SCENARIO_CATEGORY.ABNF,
    group: PAGE_GROUP.ABNF,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 30,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 30000,
    description: '验证 5 路温度中 1 路离群值被剔除，ActualTemp 按 4 路正常值计算',
    inputs: {
      sensors: [
        { key: 'temp_1', value: 20.0 },
        { key: 'temp_2', value: 20.5 },
        { key: 'temp_3', value: 20.2 },
        { key: 'temp_4', value: 20.8 },
        { key: 'temp_5', value: 50.0 },  // 离群值
      ],
      enabledCount: 5,
    },
    expected: {
      actualRegister: 0x103B,
      expectedActual: (20.0 + 20.5 + 20.2 + 20.8) / 4,  // 20.375
      tolerance: 0.2,
      deviation剔除Threshold: 10.0,
    },
    assertions: [
      { type: '离群值被剔除', rule: 'outlier_excluded_from_average' },
      { type: 'ActualTemp', rule: 'actual_temp_matches', tolerance: 0.2 },
    ],
    cleanup: ['restoreDefaultSensors', 'clearFaults'],
  },
  {
    id: 'T-ABNF-003-EVEN',
    testId: 'T-ABNF-003-B',
    scenarioId: 'SEN-ABNF-OUTLIER-EVEN-001',
    parentTestId: 'T-ABNF-003',
    name: '偶数路温度偏差剔除',
    type: SCENARIO_TYPE.ABNORMAL_FILTER,
    category: SCENARIO_CATEGORY.ABNF,
    group: PAGE_GROUP.ABNF,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 30,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 30000,
    description: '验证 4 路温度中 1 路离群值被剔除，ActualTemp 按 3 路正常值计算',
    inputs: {
      sensors: [
        { key: 'temp_1', value: 20.0 },
        { key: 'temp_2', value: 20.5 },
        { key: 'temp_3', value: 20.2 },
        { key: 'temp_4', value: 50.0 },  // 离群值
      ],
      enabledCount: 4,
    },
    expected: {
      actualRegister: 0x103B,
      expectedActual: (20.0 + 20.5 + 20.2) / 3,  // 20.233
      tolerance: 0.2,
      deviation剔除Threshold: 10.0,
    },
    assertions: [
      { type: '离群值被剔除', rule: 'outlier_excluded_from_average' },
      { type: 'ActualTemp', rule: 'actual_temp_matches', tolerance: 0.2 },
    ],
    cleanup: ['restoreDefaultSensors', 'clearFaults'],
  },

  // ----------------------------------------------------------
  // 历史回退 (2 项正式 + 1 项专项场景)
  // ----------------------------------------------------------
  {
    id: 'T-HIST-001',
    testId: 'T-HIST-001-A',
    scenarioId: 'SEN-HIST-FREEZE-001',
    parentTestId: 'T-HIST-001',
    name: '三组历史数据冻结',
    type: SCENARIO_TYPE.HISTORY_BOOT_FALLBACK,
    category: SCENARIO_CATEGORY.HIST,
    group: PAGE_GROUP.HIST,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 600,
    dependencies: ['PRE-FIELD-001', 'PRE-ENV-001'],
    timeoutMs: 600000,  // 10 分钟（含 3 次跨小时等待 + 3 次重启）
    description: '验证 3 组固定模拟值冻结后，启动回退按 tm_hour 匹配正确历史值',
    executeMode: 'caseAOnly',
    inputs: {
      freezeGroups: [
        { name: 'group-1', freezeHour: 10, verifyHour: 11, temp: 20.0, humi: 60.0 },
        { name: 'group-2', freezeHour: 14, verifyHour: 15, temp: 22.0, humi: 62.0 },
        { name: 'group-3', freezeHour: 18, verifyHour: 19, temp: 24.0, humi: 64.0 },
      ],
      sensorKeys: { temp: 'temp_1', humi: 'humi_1' },
      tolerance: 0.2,
    },
    expected: {
      actualTempRegister: 0x103B,
      actualHumiRegister: 0x103C,
      groups: [
        { verifyHour: 11, expectedTemp: 20.0, expectedHumi: 60.0 },
        { verifyHour: 15, expectedTemp: 22.0, expectedHumi: 62.0 },
        { verifyHour: 19, expectedTemp: 24.0, expectedHumi: 64.0 },
      ],
    },
    assertions: [
      { type: '历史冻结', rule: 'history_entry_matches', tolerance: 0.2 },
      { type: '启动回退', rule: 'actual_matches_frozen_value', tolerance: 0.2 },
    ],
    cleanup: ['clearFault:temp_1', 'clearFault:humi_1', 'restoreRealTime'],
  },
  {
    id: 'T-HIST-003',
    testId: 'T-HIST-003',
    scenarioId: 'SEN-HIST-TIMEGUARD-001',
    name: '历史数据更新与对时跳变防污染',
    type: SCENARIO_TYPE.HISTORY_BOOT_FALLBACK,
    category: SCENARIO_CATEGORY.HIST,
    group: PAGE_GROUP.HIST,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 300,
    dependencies: ['PRE-FIELD-001', 'PRE-ENV-001'],
    timeoutMs: 300000,
    description: '验证正常跨小时冻结和对时跳变不产生非预期历史条目',
    inputs: {
      sensorValues: { temp: 26.0, humi: 66.0 },
      freezeHour: 9,
      verifyHour: 10,
    },
    expected: {
      historyEntry: { tm_hour: 10, temp: 26.0, humi: 66.0 },
      tolerance: 0.2,
    },
    assertions: [
      { type: '跨小时冻结', rule: 'history_entry_matches', tolerance: 0.2 },
      { type: '无非预期条目', rule: 'no_pollution_after_sync' },
    ],
    cleanup: ['clearFault:temp_1', 'clearFault:humi_1', 'restoreRealTime'],
  },
  {
    id: 'SEN-HIST-BOOT-001',
    testId: 'T-HIST-001-B',
    scenarioId: 'SEN-HIST-BOOT-001',
    parentTestId: 'T-HIST-001',
    name: '启动历史回退验证',
    type: SCENARIO_TYPE.HISTORY_BOOT_FALLBACK,
    category: SCENARIO_CATEGORY.HIST,
    group: PAGE_GROUP.HIST,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 600,
    dependencies: ['PRE-FIELD-001', 'PRE-ENV-001'],
    timeoutMs: 600000,
    description: '历史回退专项场景：3 组冻结/验证数据，供 TestManager 直接加载',
    executeMode: 'caseAOnly',
    tolerance: 0.2,
    freezeGroups: [
      { name: 'group-1', freezeHour: 10, verifyHour: 11, temp: 20.0, humi: 60.0 },
      { name: 'group-2', freezeHour: 14, verifyHour: 15, temp: 22.0, humi: 62.0 },
      { name: 'group-3', freezeHour: 18, verifyHour: 19, temp: 24.0, humi: 64.0 },
    ],
    sensorKeys: { temp: 'temp_1', humi: 'humi_1' },
    cleanup: ['clearFault:temp_1', 'clearFault:humi_1', 'restoreRealTime'],
  },

  // ----------------------------------------------------------
  // 配置热更新 (7 项)
  // ----------------------------------------------------------
  {
    id: 'T-HOT-001',
    testId: 'T-HOT-001',
    scenarioId: 'SEN-HOT-ENABLE-001',
    name: '传感器启用热更新',
    type: SCENARIO_TYPE.CONFIG_HOT_UPDATE,
    category: SCENARIO_CATEGORY.HOT,
    group: PAGE_GROUP.HOT,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 15,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 15000,
    description: '启用未安装传感器后无需重启即可采集',
    inputs: {
      configRegister: 0x700A,
      enableBit: 2,  // 第 3 路温度 bit2
      sensorValue: { key: 'temp_3', value: 25.0 },
    },
    expected: {
      dataRegister: 0x1005,  // 第 3 路温度寄存器
      pollQueueRebuilt: true,
    },
    assertions: [
      { type: '配置回读', rule: 'config_readback_matches' },
      { type: '数据采集', rule: 'sensor_data_appears' },
    ],
    cleanup: ['restoreInstallConfig'],
  },
  {
    id: 'T-HOT-002',
    testId: 'T-HOT-002',
    scenarioId: 'SEN-HOT-DISABLE-001',
    name: '传感器禁用热更新',
    type: SCENARIO_TYPE.CONFIG_HOT_UPDATE,
    category: SCENARIO_CATEGORY.HOT,
    group: PAGE_GROUP.HOT,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 15,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 15000,
    description: '禁用传感器后停止抄读',
    inputs: {
      configRegister: 0x700A,
      disableBit: 1,  // 第 2 路温度 bit1
      sensorValue: { key: 'temp_2', value: 25.0 },
    },
    expected: {
      dataRegister: 0x1003,
      noNewData: true,
    },
    assertions: [
      { type: '配置回读', rule: 'config_readback_matches' },
      { type: '停止采集', rule: 'no_data_update_after_disable' },
    ],
    cleanup: ['restoreInstallConfig'],
  },
  {
    id: 'T-HOT-003',
    testId: 'T-HOT-003',
    scenarioId: 'SEN-HOT-PORT-001',
    name: 'RS485 端口切换热更新',
    type: SCENARIO_TYPE.CONFIG_HOT_UPDATE,
    category: SCENARIO_CATEGORY.HOT,
    group: PAGE_GROUP.HOT,
    priority: 'P1',
    isP1Required: true,
    estimatedSeconds: 15,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 15000,
    description: '切换传感器 RS485 端口后新端口无需重启生效',
    inputs: {
      configType: 'port_switch',
    },
    expected: {
      newPortActive: true,
      oldPortStopped: true,
    },
    assertions: [
      { type: '配置回读', rule: 'config_readback_matches' },
      { type: '新端口数据', rule: 'new_port_data_valid' },
    ],
    cleanup: ['restorePortConfig'],
  },
  {
    id: 'T-HOT-004',
    testId: 'T-HOT-004',
    scenarioId: 'SEN-HOT-TEMP-ALARM-001',
    name: '温度告警阈值热更新',
    type: SCENARIO_TYPE.CONFIG_HOT_UPDATE,
    category: SCENARIO_CATEGORY.HOT,
    group: PAGE_GROUP.HOT,
    priority: 'P1',
    isP1Required: true,
    estimatedSeconds: 30,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 30000,
    description: '修改温度告警阈值后新阈值立即参与判断',
    inputs: {
      thresholdRegister: 'temp_high_limit',
      newThreshold: 28.0,  // 写入 280
      testValue: 29.0,     // 超阈值
      recoverValue: 25.0,  // 恢复正常
    },
    expected: {
      alarmSet: true,
      alarmCleared: true,
    },
    assertions: [
      { type: '阈值回读', rule: 'threshold_readback_matches' },
      { type: '超阈值告警', rule: 'alarm_set_on_exceed' },
      { type: '恢复告警', rule: 'alarm_cleared_on_recover' },
    ],
    cleanup: ['restoreThreshold', 'restoreDefaultSensors'],
  },
  {
    id: 'T-HOT-005',
    testId: 'T-HOT-005',
    scenarioId: 'SEN-HOT-HUMI-ALARM-001',
    name: '湿度告警阈值热更新',
    type: SCENARIO_TYPE.CONFIG_HOT_UPDATE,
    category: SCENARIO_CATEGORY.HOT,
    group: PAGE_GROUP.HOT,
    priority: 'P1',
    isP1Required: true,
    estimatedSeconds: 30,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 30000,
    description: '修改湿度告警阈值后新阈值立即参与判断',
    inputs: {
      thresholdRegister: 'humi_high_limit',
      newThreshold: 55.0,  // 写入 550
      testValue: 56.0,
      recoverValue: 50.0,
    },
    expected: {
      alarmSet: true,
      alarmCleared: true,
    },
    assertions: [
      { type: '阈值回读', rule: 'threshold_readback_matches' },
      { type: '超阈值告警', rule: 'alarm_set_on_exceed' },
      { type: '恢复告警', rule: 'alarm_cleared_on_recover' },
    ],
    cleanup: ['restoreThreshold', 'restoreDefaultSensors'],
  },
  {
    id: 'T-HOT-006',
    testId: 'T-HOT-006',
    scenarioId: 'SEN-HOT-TEMP-COMP-001',
    name: '温度补偿值热更新',
    type: SCENARIO_TYPE.CONFIG_HOT_UPDATE,
    category: SCENARIO_CATEGORY.HOT,
    group: PAGE_GROUP.HOT,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 15,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 15000,
    description: '写温度补偿后采集值立即按补偿修正，恢复 0 后回原值',
    inputs: {
      compensationRegister: 'temp_comp_1',
      compensationValue: 15,  // +1.5℃
      baseSensor: { key: 'temp_1', value: 25.0 },
    },
    expected: {
      beforeCompensation: 25.0,
      afterCompensation: 26.5,
      afterRestore: 25.0,
      tolerance: 0.1,
    },
    assertions: [
      { type: '补偿生效', rule: 'value_changed_after_compensation' },
      { type: '恢复原值', rule: 'value_restored_after_zero' },
    ],
    cleanup: ['restoreCompensation:temp_comp_1', 'restoreDefaultSensors'],
  },
  {
    id: 'T-HOT-007',
    testId: 'T-HOT-007',
    scenarioId: 'SEN-HOT-HUMI-COMP-001',
    name: '湿度补偿值热更新',
    type: SCENARIO_TYPE.CONFIG_HOT_UPDATE,
    category: SCENARIO_CATEGORY.HOT,
    group: PAGE_GROUP.HOT,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 15,
    dependencies: ['PRE-FIELD-001'],
    timeoutMs: 15000,
    description: '写湿度补偿后采集值立即按补偿修正，恢复 0 后回原值',
    inputs: {
      compensationRegister: 'humi_comp_1',
      compensationValue: -20,  // -2.0%RH
      baseSensor: { key: 'humi_1', value: 60.0 },
    },
    expected: {
      beforeCompensation: 60.0,
      afterCompensation: 58.0,
      afterRestore: 60.0,
      tolerance: 0.5,
    },
    assertions: [
      { type: '补偿生效', rule: 'value_changed_after_compensation' },
      { type: '恢复原值', rule: 'value_restored_after_zero' },
    ],
    cleanup: ['restoreCompensation:humi_comp_1', 'restoreDefaultSensors'],
  },

  // ----------------------------------------------------------
  // 综合场景 (2 项)
  // ----------------------------------------------------------
  {
    id: 'T-COMP-001',
    testId: 'T-COMP-001',
    scenarioId: 'SEN-COMP-RECOVER-001',
    name: '传感器离线后恢复',
    type: SCENARIO_TYPE.COMPOSITE,
    category: SCENARIO_CATEGORY.COMP,
    group: PAGE_GROUP.COMP,
    priority: 'P0',
    isP1Required: true,
    estimatedSeconds: 60,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 60000,
    description: '通信失败触发异常后恢复，验证在线位、数据和告警恢复',
    inputs: {
      faultPhase: { key: 'temp_1', type: 'timeout' },
      recoverPhase: { key: 'temp_1', value: 25.0 },
    },
    expected: {
      beforeRecover: { dataInvalid: true, onlineCleared: true },
      afterRecover: { dataValid: true, onlineSet: true, alarmCleared: true },
    },
    assertions: [
      { type: '离线断言', rule: 'offline_state_correct' },
      { type: '恢复断言', rule: 'recovery_state_correct' },
    ],
    cleanup: ['clearFault:temp_1'],
  },
  {
    id: 'T-COMP-002',
    testId: 'T-COMP-002',
    scenarioId: 'SEN-COMP-MULTI-FAIL-001',
    name: '多路传感器同时失效',
    type: SCENARIO_TYPE.COMPOSITE,
    category: SCENARIO_CATEGORY.COMP,
    group: PAGE_GROUP.COMP,
    priority: 'P1',
    isP1Required: true,
    estimatedSeconds: 120,
    dependencies: ['PRE-FIELD-001', 'PRE-INSTALL-001'],
    timeoutMs: 120000,
    description: '8 路传感器同时异常时系统仍基于有效路计算平均值',
    inputs: {
      faultKeys: ['temp_1', 'temp_3', 'temp_5', 'temp_7', 'temp_9', 'temp_11', 'temp_13', 'temp_15'],
      normalKeys: ['temp_2', 'temp_4', 'temp_6', 'temp_8', 'temp_10', 'temp_12', 'temp_14', 'temp_16'],
      normalValue: 25.0,
    },
    expected: {
      actualRegister: 0x103B,
      expectedActual: 25.0,
      tolerance: 0.1,
      systemStable: true,
    },
    assertions: [
      { type: '失效路无效', rule: 'faulty_sensors_invalid' },
      { type: '有效路正常', rule: 'normal_sensors_valid' },
      { type: '平均值正确', rule: 'actual_based_on_valid_only', tolerance: 0.1 },
      { type: '系统稳定', rule: 'system_not_crashed' },
    ],
    cleanup: ['batchClearFault', 'restoreDefaultSensors'],
  },
];

// ============================================================
// TestScenarioCatalog 类
// ============================================================

class TestScenarioCatalog {
  constructor() {
    this._scenarios = new Map();
    for (const s of scenarios) {
      this._scenarios.set(s.id, s);
    }
  }

  /**
   * 按 ID 加载场景（支持显示 ID 和真实 ID）
   * @param {string} id 场景 ID（显示 ID 或真实 ID）
   * @returns {object|null}
   */
  loadScenario(id) {
    const realId = resolveScenarioId(id);
    const scenario = this._scenarios.get(realId);
    if (!scenario) {
      console.warn(`[TestScenarioCatalog] 场景未找到: ${id} (resolved: ${realId})`);
      return null;
    }
    return { ...scenario };
  }

  /**
   * 获取全部场景（返回页面需要的完整字段）
   * @returns {object[]}
   */
  getAllScenarios() {
    return Array.from(this._scenarios.values()).map(s => ({ ...s }));
  }

  /**
   * 按分组获取场景
   * @param {string} group 页面分组名
   * @returns {object[]}
   */
  getScenariosByGroup(group) {
    return this.getAllScenarios().filter(s => s.group === group);
  }

  /**
   * 按分类获取场景
   * @param {string} category
   * @returns {object[]}
   */
  getScenariosByCategory(category) {
    return this.getAllScenarios().filter(s => s.category === category);
  }

  /**
   * 按类型获取场景
   * @param {string} type
   * @returns {object[]}
   */
  getScenariosByType(type) {
    return this.getAllScenarios().filter(s => s.type === type);
  }

  /**
   * 获取所有场景 ID
   * @returns {string[]}
   */
  getAllScenarioIds() {
    return Array.from(this._scenarios.keys());
  }

  /**
   * 场景是否存在
   * @param {string} id
   * @returns {boolean}
   */
  hasScenario(id) {
    return this._scenarios.has(resolveScenarioId(id));
  }

  /**
   * 解析显示 ID 到真实 ID
   * @param {string} id
   * @returns {string}
   */
  resolveId(id) {
    return resolveScenarioId(id);
  }

  /**
   * 获取前置检查场景列表
   * @returns {object[]}
   */
  getPreCheckScenarios() {
    return this.getAllScenarios().filter(s => s.type === 'pre-check');
  }

  /**
   * 获取 P1 正式测试场景列表（不含前置检查）
   * @returns {object[]}
   */
  getP1Scenarios() {
    return this.getAllScenarios().filter(s => s.isP1Required === true);
  }
}

module.exports = TestScenarioCatalog;
module.exports.SCENARIO_TYPE = SCENARIO_TYPE;
module.exports.SCENARIO_CATEGORY = SCENARIO_CATEGORY;
module.exports.PAGE_GROUP = PAGE_GROUP;
module.exports.ID_ALIAS_MAP = ID_ALIAS_MAP;
module.exports.resolveScenarioId = resolveScenarioId;
