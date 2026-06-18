/**
 * HIL 自动修复闭环 Workflow
 *
 * 全自动执行: 编译 → 烧录 → 上线检测 → ATE 测试 → 诊断 → 修复 → 复测
 *
 * 触发方式:
 *   /hil-auto-fix T-READ-001
 *   /hil-auto-fix T-READ-001,T-ABNF-001
 *
 * 依赖: config/hil.config.json, scripts/hil/*.js, scripts/run-hil-test-runner.js
 */

export const meta = {
  name: 'hil-auto-fix',
  description: 'HIL 全自动闭环: 编译→烧录→测试→诊断→修复→复测',
  whenToUse: '用户要求自动跑 HIL 测试、自动修复固件、或进行传感器闭环验证时使用',
  phases: [
    { title: '构建烧录', detail: '编译固件并烧录到 GD32 环控器' },
    { title: '设备就绪', detail: '检测设备上线并确认 ATE 后端就绪' },
    { title: '执行测试', detail: '通过 ATE API 执行传感器测试用例' },
    { title: '诊断分析', detail: '分析失败根因，读取日志与源码交叉比对' },
    { title: '修复验证', detail: '修改固件代码并重新编译烧录测试' },
  ],
}

// ══════════════════════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════════════════════

const MAX_FIX_ROUNDS = 3  // 最大自动修复轮次
const HIL_CONFIG = 'config/hil.config.json'
const FIRMWARE_SRC_DIR = 'applications/app/environment'
const ALLOWED_FILES = [
  'sensoracquire.c',
  'sensor_actual_service.c',
  'sensor_analyze_service.c',
  'sensor_history_service.c',
  'sensor_read_service.c',
  'sensor_modbus_service.c',
  'sensor_value_state_service.c',
  'sensor_deployment_service.c',
  'sensor_poll_queue_service.c',
  'sensor_driver.c',  // 谨慎
]
const BLOCKED_DIRS = [
  'applications/app/system',
  'applications/app/alarm',
  'board',
  'src',
]

// ══════════════════════════════════════════════════════════
//  从 args 解析测试用例
// ══════════════════════════════════════════════════════════

const caseIds = (args || 'T-READ-001').split(',').map(s => s.trim())
const caseArg = caseIds.join(',')
log(`目标测试用例: ${caseIds.join(', ')}`)
log(`最大自动修复轮次: ${MAX_FIX_ROUNDS}`)

// ══════════════════════════════════════════════════════════
//  Phase 1: 构建烧录
// ══════════════════════════════════════════════════════════

phase('构建烧录')

const buildResult = await agent(
  `你是 HIL 构建工程师。执行以下步骤，每步完成后报告结果：

1. 编译固件:
   执行命令: node scripts/hil/build-firmware.js

2. 如果编译失败（退出码非 0 或输出包含 "失败"），停止并输出编译错误摘要。

3. 烧录固件:
   执行命令: node scripts/hil/flash-firmware.js

4. 如果烧录失败，停止并输出烧录错误摘要（常见：J-Link 未连接、芯片型号错误）。

5. 输出最终结果: "BUILD_OK" 或 "BUILD_FAIL: <原因>"`,
  { label: 'build-flash', phase: '构建烧录' }
)

if (!buildResult || buildResult.includes('BUILD_FAIL')) {
  log(`构建烧录失败，终止闭环: ${buildResult}`)
  return { success: false, stage: 'build', error: buildResult }
}

log('构建烧录完成 ✓')

// ══════════════════════════════════════════════════════════
//  Phase 2: 设备就绪检测
// ══════════════════════════════════════════════════════════

phase('设备就绪')

const readyResult = await agent(
  `你是 HIL 测试工程师。执行设备就绪检测：

1. 等待 8 秒让设备重启完成（网络协议栈初始化）。

2. 检测设备上线:
   执行命令: node scripts/hil/check-device-online.js

3. 如果设备不在线，重试 1 次（间隔 5 秒）。

4. 检查 ATE 后端是否在线:
   从 ${HIL_CONFIG} 读取 ate.baseUrl，并请求 <ate.baseUrl>/api/health。

5. 如果后端不在线，停止并提示 "请先启动后端: node backend/server.js"，同时输出当前读取到的 ate.baseUrl。

6. 输出最终结果: "READY_OK" 或 "READY_FAIL: <原因>"`,
  { label: 'device-ready', phase: '设备就绪' }
)

if (!readyResult || readyResult.includes('READY_FAIL')) {
  log(`设备就绪检测失败: ${readyResult}`)
  return { success: false, stage: 'ready', error: readyResult }
}

log('设备就绪 ✓')

// ══════════════════════════════════════════════════════════
//  Phase 3: 执行测试
// ══════════════════════════════════════════════════════════

phase('执行测试')

const testResult = await agent(
  `你是 HIL 测试执行器。执行以下步骤：

1. 使用配置驱动的 HIL runner 执行测试，不要手写 curl、端口或设备 IP：
   执行命令:
   node scripts/run-hil-test-runner.js --config ${HIL_CONFIG} --case ${caseArg} --skip-build --skip-flash --force-unlock

2. 根据命令退出码和输出判断测试结果。

3. 如果命令退出码为 0 且输出中没有失败项，输出 "TEST_PASS"。

4. 如果命令退出码非 0，或 reports/latest-hil-summary.json 中 failed > 0，输出 "TEST_FAIL"。

5. 输出:
   - 测试结果摘要: "TEST_PASS" 或 "TEST_FAIL"
   - 每个用例的状态 (pass/fail)
   - 如果有 fail，输出失败用例 ID、期望值、实际值`,
  { label: 'run-test', phase: '执行测试' }
)

if (!testResult) {
  log('测试执行异常')
  return { success: false, stage: 'test', error: 'No test result' }
}

// 检查是否全部通过
const allPassed = testResult.includes('TEST_PASS') && !testResult.includes('TEST_FAIL')

if (allPassed) {
  log('═══════════════════════════════════════')
  log('  全部测试通过! 闭环完成 ✓')
  log('═══════════════════════════════════════')
  return { success: true, stage: 'test', result: testResult }
}

log(`测试发现失败用例，进入诊断修复...`)

// ══════════════════════════════════════════════════════════
//  Phase 4 + 5: 诊断修复循环 (最多 MAX_FIX_ROUNDS 轮)
// ══════════════════════════════════════════════════════════

let fixRound = 0
let lastErrorSummary = null

while (fixRound < MAX_FIX_ROUNDS) {
  fixRound++
  log(`\n── 修复轮次 ${fixRound}/${MAX_FIX_ROUNDS} ──`)

  // ── 诊断分析 ──
  phase('诊断分析')

  const diagnosis = await agent(
    `你是嵌入式固件诊断专家。分析 HIL 测试失败原因：

## 步骤

1. 读取失败上下文:
   读取文件: logs/last_test_error.json

2. 如果文件不存在，从测试结果中提取失败信息:
   - 失败用例 ID
   - 期望值 vs 实际值
   - 失败阶段

3. 搜索相关固件源码:
   在 ${FIRMWARE_SRC_DIR}/ 目录下搜索与失败用例相关的文件。

4. 交叉分析:
   - 对比期望值和实际值的差异
   - 在源码中定位可能导致差异的代码路径
   - 检查串口日志中是否有异常信息

5. 输出诊断报告:
   问题定位: <一句话描述根因>
   相关文件: <文件列表>
   拟修改点: <具体要改哪个函数/哪一行>
   修复方案: <怎么改>

## 允许分析的文件范围
${ALLOWED_FILES.map(f => `- ${FIRMWARE_SRC_DIR}/${f}`).join('\n')}

## 禁止修改的目录
${BLOCKED_DIRS.map(d => `- ${d}/*`).join('\n')}`,
    { label: `diagnose-round-${fixRound}`, phase: '诊断分析' }
  )

  if (!diagnosis) {
    log('诊断失败，跳过本轮修复')
    continue
  }

  log(diagnosis)

  // ── 修复验证 ──
  phase('修复验证')

  const fixResult = await agent(
    `你是嵌入式固件开发工程师。根据诊断结果修复固件代码：

## 诊断结论
${diagnosis}

## 修复要求

1. 修改固件源码:
   - 只修改诊断报告中指出的文件
   - 不得修改 ${BLOCKED_DIRS.join(', ')} 下的任何文件
   - 修改前先 Read 原文件，修改后用 Edit 工具精确替换

2. 编译验证:
   执行命令: node scripts/hil/build-firmware.js
   如果编译失败，回滚修改并输出错误。

3. 烧录固件:
   执行命令: node scripts/hil/flash-firmware.js

4. 等待设备重启（8 秒）。

5. 重新执行测试:
   执行命令:
   node scripts/run-hil-test-runner.js --config ${HIL_CONFIG} --case ${caseArg} --skip-build --skip-flash --force-unlock

6. 根据 runner 退出码和 reports/latest-hil-summary.json 判断复测结果。

7. 输出:
   - 修改了哪些文件的哪些行
   - 编译是否通过
   - 复测结果: "FIX_PASS" 或 "FIX_FAIL"

## 约束
- 每轮只改诊断报告指出的代码，不扩大修改范围
- 修改后必须编译通过
- 如果编译失败，必须回滚`,
    { label: `fix-round-${fixRound}`, phase: '修复验证' }
  )

  if (!fixResult) {
    log(`修复轮次 ${fixRound} 执行异常`)
    continue
  }

  log(fixResult)

  // 检查复测结果
  if (fixResult.includes('FIX_PASS')) {
    log('═══════════════════════════════════════')
    log(`  修复成功! 第 ${fixRound} 轮闭环完成 ✓`)
    log('═══════════════════════════════════════')
    return {
      success: true,
      stage: 'fixed',
      fixRound,
      diagnosis,
      fixResult
    }
  }

  // 记录本轮失败摘要，用于检测重复失败
  lastErrorSummary = diagnosis

  log(`修复轮次 ${fixRound} 复测未通过，继续下一轮...`)
}

// ══════════════════════════════════════════════════════════
//  达到最大轮次，停止
// ══════════════════════════════════════════════════════════

log('═══════════════════════════════════════')
log(`  已达最大自动修复轮次 (${MAX_FIX_ROUNDS})，停止闭环`)
log('═══════════════════════════════════════')

// 生成人工介入报告
const reportContent = `# HIL 自动修复报告

## 概要
- 测试用例: ${caseIds.join(', ')}
- 自动修复轮次: ${fixRound}/${MAX_FIX_ROUNDS}
- 最终状态: 需要人工介入

## 最后一轮诊断
${lastErrorSummary || '无诊断信息'}

## 建议
1. 检查串口日志: logs/firmware_runtime.log
2. 检查 Modbus 交易日志: logs/modbus_trace.log
3. 手动分析固件源码中与测试用例相关的逻辑
4. 可能需要检查硬件连接或传感器模拟器配置
`

await agent(
  `写入修复报告文件 reports/hil-auto-fix-report-${new Date().toISOString().slice(0,10)}.md，内容如下:\n\n${reportContent}`,
  { label: 'write-report', phase: '修复验证' }
)

return {
  success: false,
  stage: 'max-rounds',
  fixRound,
  diagnosis: lastErrorSummary
}
