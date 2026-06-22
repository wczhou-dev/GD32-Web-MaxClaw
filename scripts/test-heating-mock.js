/**
 * scripts/test-heating-mock.js
 * 加热控制自动测试 Mock 自测脚本
 *
 * 职责：
 *   1. 在无硬件时验证加热场景编排、断言、状态机逻辑
 *   2. 覆盖室内/室外加热启停、HeatRunState 转换、参数边界
 *   3. 验证通风等级和补偿联动逻辑
 *   4. 输出 PASS/FAIL 结果和详细报告
 *
 * 运行方式：
 *   node scripts/test-heating-mock.js
 *
 * 开发依据：
 *   - P0 方案第 14 章：加热控制测试执行细则
 *   - backend/ate/TestCatalog.js：加热测试项定义
 */

'use strict';

// ============================================================
// 测试工具
// ============================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(msg) {
  console.log(`  ${msg}`);
}

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ ${testName}`);
  } else {
    failedTests++;
    console.error(`  ❌ ${testName}`);
  }
}

// ============================================================
// Mock 加热控制器 - 纯 JS 模拟固件加热逻辑
// ============================================================

/**
 * 室内加热单步模拟
 * @param {object} state - 当前状态
 * @returns {object} 新状态
 */
function mockIndoorHeatingStep(state) {
  const {
    actualTemp, expectedTemp, indoor_openTemp, indoor_closedTemp,
    openchecktime, closedchecktime, indoorState, heatRunState,
    openStartTime, closeStartTime, currentTime,
  } = state;

  const tempDiff = actualTemp - expectedTemp;
  let newIndoorState = indoorState;
  let newHeatRunState = heatRunState;
  let newOpenStart = openStartTime;
  let newCloseStart = closeStartTime;

  // 参数合法性校验：closedTemp - openTemp < 0.5 则非法
  if (indoor_closedTemp - indoor_openTemp < 0.5) {
    return {
      ...state,
      indoorState: 0,
      heatRunState: 0,
      openStartTime: 0,
      closeStartTime: 0,
      invalid: true,
    };
  }

  // 开启条件：tempDiff < openTemp
  // 两种情况：(1) 正常从 indoorState=0 开启; (2) 中断后 indoorState=1 但 heatRunState=0 重新计时
  if (tempDiff < indoor_openTemp && (indoorState === 0 || (indoorState === 1 && heatRunState === 0))) {
    newCloseStart = 0;
    // 从 OFF_HOLD(3) 或其他非 IDLE 状态进入开启区间时，重置为 IDLE
    if (newHeatRunState !== 0 && newHeatRunState !== 1) {
      newHeatRunState = 0;
    }
    // 中断重入时，openStartTime 已由下方中断处理代码设置，此处仅处理正常首次
    if (newOpenStart === 0) {
      newOpenStart = currentTime;
    }
    if (currentTime - newOpenStart >= openchecktime * 60) {
      newIndoorState = 1;
      newHeatRunState = 1;
    }
  }
  // 关闭条件：tempDiff >= closedTemp 且当前已开启
  else if (tempDiff >= indoor_closedTemp && indoorState === 1) {
    newOpenStart = 0;
    if (newCloseStart === 0) {
      newCloseStart = currentTime;
      newHeatRunState = 2;
    }
    if (currentTime - newCloseStart >= closedchecktime * 60) {
      newIndoorState = 0;
      newHeatRunState = 3;
    }
  }
  // 不满足开启/关闭条件
  else {
    newOpenStart = 0;
    newCloseStart = 0;
    // OFF_HOLD(3) 保持，其他回到 IDLE
    if (newHeatRunState !== 3) {
      newHeatRunState = 0;
    }
  }

  // 中断处理：CLOSE_PENDING(indoorState=1) 阶段温度骤降回开启区间
  // 重新进入 IDLE 计时阶段
  if (tempDiff < indoor_openTemp && indoorState === 1 && newHeatRunState === 0 && newOpenStart === 0) {
    newOpenStart = currentTime;
  }

  return {
    ...state,
    indoorState: newIndoorState,
    heatRunState: newHeatRunState,
    openStartTime: newOpenStart,
    closeStartTime: newCloseStart,
  };
}

/**
 * 室外加热单步模拟
 * @param {object} state - 当前状态
 * @returns {object} 新状态
 */
function mockOutdoorHeatingStep(state) {
  const {
    actualTemp, expectedTemp, outdoor_openTemp, outdoor_closedTemp,
    outdoorState, outdoorOpenStartTime, outdoorCloseStartTime,
    currentTime,
  } = state;

  let newOutdoorState = outdoorState;
  let newOpenStart = outdoorOpenStartTime;
  let newCloseStart = outdoorCloseStartTime;

  // 开启条件：ActualTemp <= ExpectedTemp - outdoor_openTemp
  if (actualTemp <= expectedTemp - outdoor_openTemp && outdoorState === 0) {
    newCloseStart = 0;
    if (newOpenStart === 0) {
      newOpenStart = currentTime;
    }
    newOutdoorState = 1;
  }
  // 关闭条件：ActualTemp >= ExpectedTemp - outdoor_closedTemp
  else if (actualTemp >= expectedTemp - outdoor_closedTemp && outdoorState === 1) {
    newOpenStart = 0;
    if (newCloseStart === 0) {
      newCloseStart = currentTime;
    }
    newOutdoorState = 0;
  }
  // 滞后区保持
  else {
    // 保持当前状态
  }

  return {
    ...state,
    outdoorState: newOutdoorState,
    outdoorOpenStartTime: newOpenStart,
    outdoorCloseStartTime: newCloseStart,
  };
}

/**
 * 参数范围校验
 * @param {object} params - 加热参数
 * @returns {object} { valid, corrected, corrections[] }
 */
function mockValidateParams(params) {
  const corrections = [];
  let valid = true;
  const corrected = { ...params };

  // openchecktime 有效范围 [0, 60]
  if (corrected.openchecktime > 60) {
    corrections.push({ field: 'openchecktime', from: corrected.openchecktime, to: 0 });
    corrected.openchecktime = 0;
  }
  if (corrected.openchecktime < 0) {
    corrections.push({ field: 'openchecktime', from: corrected.openchecktime, to: 0 });
    corrected.openchecktime = 0;
  }

  // closedchecktime 有效范围 [0, 60]
  if (corrected.closedchecktime > 60) {
    corrections.push({ field: 'closedchecktime', from: corrected.closedchecktime, to: 0 });
    corrected.closedchecktime = 0;
  }
  if (corrected.closedchecktime < 0) {
    corrections.push({ field: 'closedchecktime', from: corrected.closedchecktime, to: 0 });
    corrected.closedchecktime = 0;
  }

  // 开启温度阈值有效范围 [-10, 10]
  if (corrected.indoor_openTemp > 10 || corrected.indoor_openTemp < -10) {
    corrections.push({ field: 'indoor_openTemp', from: corrected.indoor_openTemp, to: -2 });
    corrected.indoor_openTemp = -2;
  }

  // 关闭温度阈值有效范围 [-10, 10]
  if (corrected.indoor_closedTemp > 10 || corrected.indoor_closedTemp < -10) {
    corrections.push({ field: 'indoor_closedTemp', from: corrected.indoor_closedTemp, to: 2 });
    corrected.indoor_closedTemp = 2;
  }

  // 阈值间隔校验
  if (corrected.indoor_closedTemp - corrected.indoor_openTemp < 0.5) {
    valid = false;
  }

  return { valid, corrected, corrections };
}

/**
 * 通风等级联动判定
 * @param {number} heatRunState - 加热运行状态 (0=IDLE, 1=ON, 2=CLOSE_PENDING, 3=OFF_HOLD)
 * @param {number} currentVentLevel - 当前通风等级
 * @param {boolean} wantVentUp - 是否请求提升通风等级
 * @returns {object} { ventUpAllowed, compensationActive }
 */
function mockVentCompLinkage(heatRunState, currentVentLevel, wantVentUp) {
  let ventUpAllowed = false;
  let compensationActive = false;

  switch (heatRunState) {
    case 0: // IDLE
      ventUpAllowed = wantVentUp;
      compensationActive = true;
      break;
    case 1: // ON - 加热中
      ventUpAllowed = false;
      compensationActive = false;
      break;
    case 2: // CLOSE_PENDING - 关闭待确认
      ventUpAllowed = false;
      compensationActive = false;
      break;
    case 3: // OFF_HOLD - 关闭后保持
      ventUpAllowed = false;
      compensationActive = false;
      break;
    default:
      ventUpAllowed = false;
      compensationActive = false;
  }

  return { ventUpAllowed, compensationActive };
}

// ============================================================
// 加热场景目录 Mock
// ============================================================

/**
 * Mock 加热场景目录
 * 定义加热测试场景集合
 */
const MOCK_HEATING_SCENARIOS = [
  {
    id: 'HT-INDOOR-001',
    name: '室内加热开启验证',
    type: 'indoor',
    group: 'indoor',
    assertions: ['relay_on', 'state_match', 'heatrun_on'],
    description: '验证室内温度低于阈值时加热继电器开启',
  },
  {
    id: 'HT-INDOOR-002',
    name: '室内加热关闭验证',
    type: 'indoor',
    group: 'indoor',
    assertions: ['relay_off', 'state_match', 'heatrun_idle'],
    description: '验证室内温度回升后加热继电器关闭',
  },
  {
    id: 'HT-OUTDOOR-001',
    name: '室外加热开启验证',
    type: 'outdoor',
    group: 'outdoor',
    assertions: ['relay_on', 'state_match'],
    description: '验证室外温度低于阈值时室外加热开启',
  },
  {
    id: 'HT-OUTDOOR-002',
    name: '室外加热关闭验证',
    type: 'outdoor',
    group: 'outdoor',
    assertions: ['relay_off', 'state_match'],
    description: '验证室外温度回升后室外加热关闭',
  },
  {
    id: 'HT-PARAM-001',
    name: '参数范围校验',
    type: 'param',
    group: 'param',
    assertions: ['param_valid'],
    description: '验证加热参数在有效范围内',
  },
  {
    id: 'HT-PARAM-002',
    name: '参数越界修正',
    type: 'param',
    group: 'param',
    assertions: ['param_corrected'],
    description: '验证越界参数自动修正为默认值',
  },
  {
    id: 'HT-PARAM-003',
    name: '阈值间隔非法检测',
    type: 'param',
    group: 'param',
    assertions: ['param_illegal'],
    description: '验证 closedTemp - openTemp < 0.5 时判定非法',
  },
  {
    id: 'HT-STATE-001',
    name: 'HeatRunState 状态机完整转换',
    type: 'state',
    group: 'state',
    assertions: ['heatrun_transition'],
    description: '验证 IDLE→ON→CLOSE_PENDING→OFF_HOLD→IDLE 全流程',
  },
  {
    id: 'HT-STATE-002',
    name: 'HeatRunState 中断场景',
    type: 'state',
    group: 'state',
    assertions: ['heatrun_interrupt'],
    description: '验证 CLOSE_PENDING 和 OFF_HOLD 阶段可被重新开启中断',
  },
  {
    id: 'HT-VENT-001',
    name: '通风联动验证',
    type: 'vent',
    group: 'vent',
    assertions: ['vent_linkage'],
    description: '验证加热状态对通风等级提升的门控逻辑',
  },
  {
    id: 'HT-COMP-001',
    name: '补偿联动验证',
    type: 'comp',
    group: 'comp',
    assertions: ['comp_linkage'],
    description: '验证加热状态对温度补偿的门控逻辑',
  },
  {
    id: 'HT-TIMER-001',
    name: '持续确认计时验证',
    type: 'timer',
    group: 'timer',
    assertions: ['timer_match'],
    description: '验证 openchecktime / closedchecktime 计时正确',
  },
  {
    id: 'HT-HOLD-001',
    name: '关闭后保持验证',
    type: 'hold',
    group: 'hold',
    assertions: ['hold_match'],
    description: '验证关闭后 OFF_HOLD 状态保持时间',
  },
  {
    id: 'HT-REMOTE-001',
    name: '远程模式跳过验证',
    type: 'remote',
    group: 'remote',
    assertions: ['remote_skip'],
    description: '验证远程模式下加热逻辑跳过',
  },
  {
    id: 'HT-DEPLOY-001',
    name: '部署位关闭验证',
    type: 'deploy',
    group: 'deploy',
    assertions: ['deploy_off'],
    description: '验证部署位关闭时加热逻辑不执行',
  },
];

function getScenariosByGroup(group) {
  return MOCK_HEATING_SCENARIOS.filter(s => s.group === group);
}

function getScenariosByType(type) {
  return MOCK_HEATING_SCENARIOS.filter(s => s.type === type);
}

function hasScenario(id) {
  return MOCK_HEATING_SCENARIOS.some(s => s.id === id);
}

// ============================================================
// 时间戳工具 (模块级，供所有测试用例使用)
// ============================================================

/** 时间戳简化：分钟→秒，避免手算 */
const TS = (sec) => sec;
/** 确认时间：3 分钟 = 180 秒 */
const CHECK_TIME = 3;

// ============================================================
// 测试用例
// ============================================================

/**
 * 1. HeatingScenarioCatalog 验证
 */
async function testScenarioCatalog() {
  console.log('\n=== 1. 加热场景目录验证 ===');

  // 场景总数
  assert(
    MOCK_HEATING_SCENARIOS.length === 15,
    `场景总数 15 (实际 ${MOCK_HEATING_SCENARIOS.length})`
  );

  // 每个场景必须有 id, name, type, assertions
  for (const s of MOCK_HEATING_SCENARIOS) {
    const hasId = typeof s.id === 'string' && s.id.length > 0;
    const hasName = typeof s.name === 'string' && s.name.length > 0;
    const hasType = typeof s.type === 'string' && s.type.length > 0;
    const hasAssertions = Array.isArray(s.assertions) && s.assertions.length > 0;
    assert(
      hasId && hasName && hasType && hasAssertions,
      `${s.id}: 必需字段完整 (id/name/type/assertions)`
    );
  }

  // getScenariosByGroup 测试
  const indoorScenarios = getScenariosByGroup('indoor');
  assert(indoorScenarios.length === 2, `indoor 分组 2 个场景 (实际 ${indoorScenarios.length})`);

  const outdoorScenarios = getScenariosByGroup('outdoor');
  assert(outdoorScenarios.length === 2, `outdoor 分组 2 个场景 (实际 ${outdoorScenarios.length})`);

  const paramScenarios = getScenariosByGroup('param');
  assert(paramScenarios.length === 3, `param 分组 3 个场景 (实际 ${paramScenarios.length})`);

  const stateScenarios = getScenariosByGroup('state');
  assert(stateScenarios.length === 2, `state 分组 2 个场景 (实际 ${stateScenarios.length})`);

  // getScenariosByType 测试
  const typeIndoor = getScenariosByType('indoor');
  assert(typeIndoor.length === 2, `type=indoor 返回 2 个场景`);

  const typeOutdoor = getScenariosByType('outdoor');
  assert(typeOutdoor.length === 2, `type=outdoor 返回 2 个场景`);

  const typeParam = getScenariosByType('param');
  assert(typeParam.length === 3, `type=param 返回 3 个场景`);

  const typeState = getScenariosByType('state');
  assert(typeState.length === 2, `type=state 返回 2 个场景`);

  // hasScenario 测试
  assert(hasScenario('HT-INDOOR-001'), 'hasScenario(HT-INDOOR-001) = true');
  assert(hasScenario('HT-OUTDOOR-001'), 'hasScenario(HT-OUTDOOR-001) = true');
  assert(hasScenario('HT-PARAM-001'), 'hasScenario(HT-PARAM-001) = true');
  assert(hasScenario('HT-STATE-001'), 'hasScenario(HT-STATE-001) = true');
  assert(hasScenario('HT-VENT-001'), 'hasScenario(HT-VENT-001) = true');
  assert(hasScenario('HT-COMP-001'), 'hasScenario(HT-COMP-001) = true');
  assert(!hasScenario('HT-INVALID-999'), 'hasScenario(HT-INVALID-999) = false');
  assert(!hasScenario(''), 'hasScenario(空字符串) = false');

  // 10 个分组 (indoor, outdoor, param, state, vent, comp, timer, hold, remote, deploy)
  const allGroups = [...new Set(MOCK_HEATING_SCENARIOS.map(s => s.group))];
  assert(allGroups.length === 10, `10 个分组 (实际 ${allGroups.length})`);
}

/**
 * 2. 加热参数逻辑 Mock
 */
async function testParameterLogic() {
  console.log('\n=== 2. 加热参数逻辑 Mock ===');

  // --- 温度阈值触发逻辑 ---
  // tempDiff < indoor_openTemp 触发开启
  {
    let state = {
      actualTemp: 15, expectedTemp: 22, indoor_openTemp: -2, indoor_closedTemp: 2,
      openchecktime: 5, closedchecktime: 5, indoorState: 0, heatRunState: 0,
      openStartTime: 0, closeStartTime: 0, currentTime: 1000,
    };
    const result = mockIndoorHeatingStep(state);
    assert(result.openStartTime === 1000, 'tempDiff=-7 < openTemp=-2 → 开启计时开始 (openStartTime=1000)');
    assert(result.heatRunState === 0, '首次触发 heatRunState 保持 0 (未到计时)');
  }

  // tempDiff >= indoor_closedTemp 触发关闭
  {
    let state = {
      actualTemp: 25, expectedTemp: 22, indoor_openTemp: -2, indoor_closedTemp: 2,
      openchecktime: 5, closedchecktime: 5, indoorState: 1, heatRunState: 1,
      openStartTime: 0, closeStartTime: 0, currentTime: 5000,
    };
    const result = mockIndoorHeatingStep(state);
    assert(result.closeStartTime === 5000, 'tempDiff=3 >= closedTemp=2 → 关闭计时开始 (closeStartTime=5000)');
    assert(result.heatRunState === 2, '进入 CLOSE_PENDING (heatRunState=2)');
  }

  // 阈值间隔非法：closedTemp - openTemp < 0.5
  {
    const result = mockValidateParams({
      openchecktime: 5, closedchecktime: 5,
      indoor_openTemp: 1, indoor_closedTemp: 1.2,
    });
    assert(result.valid === false, 'closedTemp - openTemp = 0.2 < 0.5 → valid=false');
    assert(result.corrected.indoor_openTemp === 1, '非法参数值保留供调试');
  }

  // 阈值间隔合法：closedTemp - openTemp >= 0.5
  {
    const result = mockValidateParams({
      openchecktime: 5, closedchecktime: 5,
      indoor_openTemp: -2, indoor_closedTemp: 2,
    });
    assert(result.valid === true, 'closedTemp - openTemp = 4 >= 0.5 → valid=true');
  }

  // --- 参数范围校验 ---
  // openchecktime ≤ 60
  {
    const result = mockValidateParams({
      openchecktime: 70, closedchecktime: 5,
      indoor_openTemp: -2, indoor_closedTemp: 2,
    });
    assert(result.corrections.length === 1, 'openchecktime=70 → 1 个修正');
    assert(result.corrected.openchecktime === 0, 'openchecktime=70 → 修正为 0');
  }

  // closedchecktime ≤ 60
  {
    const result = mockValidateParams({
      openchecktime: 5, closedchecktime: 80,
      indoor_openTemp: -2, indoor_closedTemp: 2,
    });
    assert(result.corrections.length === 1, 'closedchecktime=80 → 1 个修正');
    assert(result.corrected.closedchecktime === 0, 'closedchecktime=80 → 修正为 0');
  }

  // openTemp 越界修正: 15 → -2
  {
    const result = mockValidateParams({
      openchecktime: 5, closedchecktime: 5,
      indoor_openTemp: 15, indoor_closedTemp: 20,
    });
    assert(result.corrections.length === 2, 'openTemp=15, closedTemp=20 → 2 个修正');
    assert(result.corrected.indoor_openTemp === -2, 'openTemp=15 → 修正为 -2');
    assert(result.corrected.indoor_closedTemp === 2, 'closedTemp=20 → 修正为 2');
  }

  // openTemp 下界越界: -15 → -2
  {
    const result = mockValidateParams({
      openchecktime: 5, closedchecktime: 5,
      indoor_openTemp: -15, indoor_closedTemp: 2,
    });
    assert(result.corrections.length === 1, 'openTemp=-15 → 1 个修正');
    assert(result.corrected.indoor_openTemp === -2, 'openTemp=-15 → 修正为 -2');
  }

  // 正常参数无需修正
  {
    const result = mockValidateParams({
      openchecktime: 5, closedchecktime: 5,
      indoor_openTemp: -2, indoor_closedTemp: 2,
    });
    assert(result.corrections.length === 0, '正常参数无需修正');
    assert(result.valid === true, '正常参数 valid=true');
  }

  // 多参数同时越界
  {
    const result = mockValidateParams({
      openchecktime: 100, closedchecktime: -5,
      indoor_openTemp: 20, indoor_closedTemp: 25,
    });
    assert(result.corrections.length === 4, '4 个参数同时越界 → 4 个修正');
    assert(result.corrected.openchecktime === 0, 'openchecktime=100 → 0');
    assert(result.corrected.closedchecktime === 0, 'closedchecktime=-5 → 0');
    assert(result.corrected.indoor_openTemp === -2, 'openTemp=20 → -2');
    assert(result.corrected.indoor_closedTemp === 2, 'closedTemp=25 → 2');
  }
}

/**
 * 3. HeatRunState 状态机 Mock
 */
async function testHeatRunStateMachine() {
  console.log('\n=== 3. HeatRunState 状态机 Mock ===');

  // --- 完整流程: IDLE → ON → CLOSE_PENDING → OFF_HOLD → IDLE ---

  // IDLE → (触发开启) → 开始计时
  // 使用非零起始时间避免 openStartTime=0 哨兵值冲突
  let state = {
    actualTemp: 15, expectedTemp: 22, indoor_openTemp: -2, indoor_closedTemp: 2,
    openchecktime: CHECK_TIME, closedchecktime: CHECK_TIME,
    indoorState: 0, heatRunState: 0,
    openStartTime: 0, closeStartTime: 0, currentTime: TS(1000),
  };
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 0, '初始 IDLE (heatRunState=0)');
  assert(state.openStartTime === TS(1000), 'IDLE→计时开始 (openStartTime=1000)');
  assert(state.indoorState === 0, 'indoorState 保持 0 (未确认)');

  // 计时未满：不转换 (经过 60 秒，需要 180 秒)
  state.currentTime = TS(1060);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 0, '计时 60s < 180s → 保持 IDLE');
  assert(state.indoorState === 0, 'indoorState 保持 0');

  // 计时满足：IDLE → ON (经过 180 秒)
  state.currentTime = TS(1180);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 1, 'IDLE→ON (heatRunState=1)');
  assert(state.indoorState === 1, 'indoorState=1 (开启)');

  // ON → 触发关闭 → CLOSE_PENDING
  state.actualTemp = 25; // tempDiff = 3 >= closedTemp = 2
  state.currentTime = TS(1500);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 2, 'ON→CLOSE_PENDING (heatRunState=2)');
  assert(state.closeStartTime === TS(1500), '关闭计时开始 (closeStartTime=1500)');
  assert(state.indoorState === 1, 'indoorState 保持 1 (关闭未确认)');

  // CLOSE_PENDING → 关闭计时未满 (经过 100 秒，需要 180 秒)
  state.currentTime = TS(1600);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 2, '关闭计时未满 → 保持 CLOSE_PENDING');

  // CLOSE_PENDING → OFF_HOLD (关闭计时满足 180 秒)
  state.currentTime = TS(1680);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 3, 'CLOSE_PENDING→OFF_HOLD (heatRunState=3)');
  assert(state.indoorState === 0, 'indoorState=0 (关闭)');

  // OFF_HOLD → 温度在滞区内 → 保持 OFF_HOLD
  state.actualTemp = 21; // tempDiff = -1, 在 (-2, 2) 之间
  state.currentTime = TS(2000);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 3, 'OFF_HOLD 在滞区内保持 (heatRunState=3)');

  // OFF_HOLD → 温度仍在滞区 → 保持 OFF_HOLD
  state.actualTemp = 23; // tempDiff = 1, 在 (-2, 2) 之间
  state.currentTime = TS(2200);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 3, 'OFF_HOLD→温度回升仍在滞区 → 保持 OFF_HOLD');
}

/**
 * 4. HeatRunState 中断场景
 */
async function testHeatRunInterrupt() {
  console.log('\n=== 4. HeatRunState 中断场景 ===');

  // --- CLOSE_PENDING 中断：重新开启 ---
  // 模拟从 ON 阶段进入 CLOSE_PENDING，openStartTime 已在 ON 阶段被清零
  // 使用闭包起始时间避免 openStartTime=0 哨兵值冲突
  let state = {
    actualTemp: 25, expectedTemp: 22, indoor_openTemp: -2, indoor_closedTemp: 2,
    openchecktime: CHECK_TIME, closedchecktime: CHECK_TIME,
    indoorState: 1, heatRunState: 2, // 已在 CLOSE_PENDING
    openStartTime: TS(900), closeStartTime: TS(1000), currentTime: TS(1050),
  };

  // 温度骤降 → 重新触发开启
  state.actualTemp = 15; // tempDiff = -7 < openTemp = -2
  state.currentTime = TS(1100);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 0, 'CLOSE_PENDING→温度骤降→重新计时 (heatRunState=0, 归零再计时)');
  assert(state.openStartTime === TS(1100), '开启计时重新开始 (openStartTime=1100)');
  assert(state.closeStartTime === 0, '关闭计时清零');

  // 重新计时满足 → ON (180 秒后)
  state.currentTime = TS(1280);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 1, '重新计时满足→ON (heatRunState=1)');
  assert(state.indoorState === 1, 'indoorState=1');

  // --- OFF_HOLD 中断：重新开启 ---
  // 进入 OFF_HOLD 时 openStartTime 已在 CLOSE 阶段被清零
  state = {
    actualTemp: 25, expectedTemp: 22, indoor_openTemp: -2, indoor_closedTemp: 2,
    openchecktime: CHECK_TIME, closedchecktime: CHECK_TIME,
    indoorState: 0, heatRunState: 3, // 已在 OFF_HOLD
    openStartTime: 0, closeStartTime: 0, currentTime: TS(3000),
  };

  // 温度骤降 → 重新触发开启
  state.actualTemp = 10; // tempDiff = -12 < openTemp = -2
  state.currentTime = TS(3100);
  state = mockIndoorHeatingStep(state);
  assert(state.openStartTime === TS(3100), 'OFF_HOLD→温度骤降→开启计时开始');
  assert(state.heatRunState === 0, 'OFF_HOLD 中断→重新进入 IDLE 计时');

  // 计时满足 → ON (180 秒后)
  state.currentTime = TS(3280);
  state = mockIndoorHeatingStep(state);
  assert(state.heatRunState === 1, 'OFF_HOLD 中断后重新开启→ON');
  assert(state.indoorState === 1, 'indoorState=1');
}

/**
 * 5. 室外加热逻辑 Mock
 */
async function testOutdoorHeatingLogic() {
  console.log('\n=== 5. 室外加热逻辑 Mock ===');

  // 开启条件：ActualTemp <= ExpectedTemp - outdoor_openTemp
  {
    let state = {
      actualTemp: 5, expectedTemp: 22, outdoor_openTemp: 3, outdoor_closedTemp: 1,
      outdoorState: 0, outdoorOpenStartTime: 0, outdoorCloseStartTime: 0, currentTime: 100,
    };
    // 5 <= 22 - 3 = 19 → 开启
    const result = mockOutdoorHeatingStep(state);
    assert(result.outdoorState === 1, 'ActualTemp=5 <= Expected-openTemp=19 → outdoorState=1 (开启)');
    assert(result.outdoorOpenStartTime === 100, '开启计时开始 (outdoorOpenStartTime=100)');
  }

  // 关闭条件：ActualTemp >= ExpectedTemp - outdoor_closedTemp
  {
    let state = {
      actualTemp: 22, expectedTemp: 22, outdoor_openTemp: 3, outdoor_closedTemp: 1,
      outdoorState: 1, outdoorOpenStartTime: 100, outdoorCloseStartTime: 0, currentTime: 500,
    };
    // 22 >= 22 - 1 = 21 → 关闭
    const result = mockOutdoorHeatingStep(state);
    assert(result.outdoorState === 0, 'ActualTemp=22 >= Expected-closedTemp=21 → outdoorState=0 (关闭)');
    assert(result.outdoorCloseStartTime === 500, '关闭计时开始 (outdoorCloseStartTime=500)');
  }

  // 滞后区保持：温度在开启和关闭阈值之间
  {
    let state = {
      actualTemp: 20, expectedTemp: 22, outdoor_openTemp: 3, outdoor_closedTemp: 1,
      outdoorState: 1, outdoorOpenStartTime: 0, outdoorCloseStartTime: 0, currentTime: 300,
    };
    // 20 < 22-1=21 (不满足关闭) && 20 > 22-3=19 (不满足开启) → 保持
    const result = mockOutdoorHeatingStep(state);
    assert(result.outdoorState === 1, '滞区内 ActualTemp=20 保持 outdoorState=1');
    assert(result.outdoorCloseStartTime === 0, '滞区内不启动关闭计时');
  }

  // 边界值：ActualTemp == ExpectedTemp - outdoor_openTemp
  {
    let state = {
      actualTemp: 19, expectedTemp: 22, outdoor_openTemp: 3, outdoor_closedTemp: 1,
      outdoorState: 0, outdoorOpenStartTime: 0, outdoorCloseStartTime: 0, currentTime: 400,
    };
    // 19 <= 22-3=19 → 开启
    const result = mockOutdoorHeatingStep(state);
    assert(result.outdoorState === 1, '边界 ActualTemp=19 == Expected-openTemp → 开启');
  }

  // 边界值：ActualTemp == ExpectedTemp - outdoor_closedTemp
  {
    let state = {
      actualTemp: 21, expectedTemp: 22, outdoor_openTemp: 3, outdoor_closedTemp: 1,
      outdoorState: 1, outdoorOpenStartTime: 0, outdoorCloseStartTime: 0, currentTime: 600,
    };
    // 21 >= 22-1=21 → 关闭
    const result = mockOutdoorHeatingStep(state);
    assert(result.outdoorState === 0, '边界 ActualTemp=21 == Expected-closedTemp → 关闭');
  }

  // 未开启状态下不满足开启条件 → 保持关闭
  {
    let state = {
      actualTemp: 22, expectedTemp: 22, outdoor_openTemp: 3, outdoor_closedTemp: 1,
      outdoorState: 0, outdoorOpenStartTime: 0, outdoorCloseStartTime: 0, currentTime: 700,
    };
    // 22 > 19 → 不开启
    const result = mockOutdoorHeatingStep(state);
    assert(result.outdoorState === 0, 'ActualTemp=22 > 19 → 保持 outdoorState=0');
    assert(result.outdoorOpenStartTime === 0, '不满足开启 → 不启动计时');
  }

  // 滞后区保持（已关闭状态）
  {
    let state = {
      actualTemp: 20.5, expectedTemp: 22, outdoor_openTemp: 3, outdoor_closedTemp: 1,
      outdoorState: 0, outdoorOpenStartTime: 0, outdoorCloseStartTime: 0, currentTime: 800,
    };
    // 20.5 > 19 (不开启) && 20.5 < 21 (不关闭) → 保持
    const result = mockOutdoorHeatingStep(state);
    assert(result.outdoorState === 0, '已关闭态滞区内 ActualTemp=20.5 → 保持 outdoorState=0');
  }
}

/**
 * 6. 通风/补偿联动 Mock
 */
async function testVentCompLinkage() {
  console.log('\n=== 6. 通风/补偿联动 Mock ===');

  // HeatRunState=0 (IDLE)：通风提升允许，补偿激活
  {
    const result = mockVentCompLinkage(0, 1, true);
    assert(result.ventUpAllowed === true, 'IDLE: ventUpAllowed=true');
    assert(result.compensationActive === true, 'IDLE: compensationActive=true');
  }

  // HeatRunState=0 (IDLE)：不请求提升
  {
    const result = mockVentCompLinkage(0, 1, false);
    assert(result.ventUpAllowed === false, 'IDLE: 不请求提升 → ventUpAllowed=false');
    assert(result.compensationActive === true, 'IDLE: 补偿仍然激活');
  }

  // HeatRunState=1 (ON)：通风提升阻塞，补偿阻塞
  {
    const result = mockVentCompLinkage(1, 1, true);
    assert(result.ventUpAllowed === false, 'ON: ventUpAllowed=false');
    assert(result.compensationActive === false, 'ON: compensationActive=false');
  }

  // HeatRunState=2 (CLOSE_PENDING)：通风提升阻塞
  {
    const result = mockVentCompLinkage(2, 1, true);
    assert(result.ventUpAllowed === false, 'CLOSE_PENDING: ventUpAllowed=false');
    assert(result.compensationActive === false, 'CLOSE_PENDING: compensationActive=false');
  }

  // HeatRunState=3 (OFF_HOLD)：通风提升阻塞
  {
    const result = mockVentCompLinkage(3, 1, true);
    assert(result.ventUpAllowed === false, 'OFF_HOLD: ventUpAllowed=false');
    assert(result.compensationActive === false, 'OFF_HOLD: compensationActive=false');
  }

  // 各状态下均阻塞通风提升（非 IDLE 全部验证）
  for (let hrs = 1; hrs <= 3; hrs++) {
    const result = mockVentCompLinkage(hrs, 3, true);
    assert(
      result.ventUpAllowed === false,
      `HeatRunState=${hrs}: 通风提升阻塞`
    );
    assert(
      result.compensationActive === false,
      `HeatRunState=${hrs}: 补偿阻塞`
    );
  }
}

/**
 * 7. TestCatalog 加热测试项验证
 */
async function testCatalogIntegration() {
  console.log('\n=== 7. TestCatalog 加热测试项验证 ===');

  const { ERROR_CODE } = require('../shared/constants');

  // 验证所有 HEATING_* 错误码已定义
  const heatingErrorCodes = [
    'HEATING_RELAY_FAIL',
    'HEATING_STATE_MISMATCH',
    'HEATING_THRESHOLD_FAIL',
    'HEATING_PARAM_OUT_OF_RANGE',
    'HEATING_PARAM_CORRECTION',
    'HEATING_PARAM_ILLEGAL',
    'HEATING_TIMER_FAIL',
    'HEATING_HOLD_FAIL',
    'HEATING_HEATRUN_STATE',
    'HEATING_VENT_LINKAGE',
    'HEATING_COMP_LINKAGE',
    'HEATING_REMOTE_MODE',
    'HEATING_DEPLOY_BIT',
    'HEATING_OUTDOOR_FAIL',
  ];

  for (const code of heatingErrorCodes) {
    assert(
      typeof ERROR_CODE[code] === 'number',
      `ERROR_CODE.${code} = 0x${(ERROR_CODE[code] || 0).toString(16).toUpperCase().padStart(4, '0')} 已定义`
    );
  }

  // 验证 TestCatalog 中 id=105 有正确配置
  const TestCatalog = require('../backend/ate/TestCatalog');
  const catalog = new TestCatalog();
  const item105 = catalog.getItemById(105);

  assert(item105 !== null, 'TestCatalog: id=105 存在');
  assert(item105.name === '加热控制测试', `id=105 name = "${item105.name}"`);
  assert(item105.category === '业务逻辑', `id=105 category = "${item105.category}"`);
  assert(item105.timeoutMs === 300000, `id=105 timeoutMs = ${item105.timeoutMs}`);
  assert(
    item105.errorCodes.length === 14,
    `id=105 有 14 个错误码 (实际 ${item105.errorCodes.length})`
  );

  // 验证每个错误码非零
  for (const code of item105.errorCodes) {
    assert(
      typeof code === 'number' && code > 0,
      `id=105 错误码 0x${code.toString(16).toUpperCase().padStart(4, '0')} 有效`
    );
  }

  // 验证步骤定义
  assert(
    Array.isArray(item105.steps) && item105.steps.length >= 4,
    `id=105 有 ${item105.steps ? item105.steps.length : 0} 个步骤`
  );
}

// ============================================================
// 主测试流程
// ============================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  加热控制自动测试 Mock 自测                      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`运行时间: ${new Date().toISOString()}`);

  try {
    await testScenarioCatalog();
    await testParameterLogic();
    await testHeatRunStateMachine();
    await testHeatRunInterrupt();
    await testOutdoorHeatingLogic();
    await testVentCompLinkage();
    await testCatalogIntegration();

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  测试结果汇总                                    ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  总计: ${totalTests}`);
    console.log(`  通过: ${passedTests} ✅`);
    console.log(`  失败: ${failedTests} ❌`);
    console.log(`  结论: ${failedTests === 0 ? '全部通过 ✅' : '存在失败 ❌'}`);

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('\n💥 测试异常:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
