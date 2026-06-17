# HIL 自动测试与修复工作流

## 概述

本工作流定义了 Claude Code 智能体如何驱动 HIL 闭环测试：编译 → 烧录 → 测试 → 诊断 → 修复 → 复测。

## 触发方式

在 Claude Code 中输入以下指令之一：
- "跑一轮 HIL 自动修复"
- "用 workflow 跑 T-READ-001 的完整闭环"
- "启动 HIL 自动测试"

## 工具链映射

| HIL 步骤 | Claude Code 工具 | 命令 |
| --- | --- | --- |
| 编译固件 | Bash | `node scripts/hil/build-firmware.js` |
| 烧录固件 | Bash | `node scripts/hil/flash-firmware.js` |
| 检测设备在线 | Bash | `node scripts/hil/check-device-online.js` |
| 触发 ATE 测试 | Bash | `curl -X POST http://localhost:3000/api/sensor-test/run-batch` |
| 轮询结果 | Bash | `curl http://localhost:3000/api/sensor-test/current-session` |
| 读取失败上下文 | Read | `logs/last_test_error.json` |
| 搜索固件源码 | Grep / Glob | 在 `applications/app/environment/` 下搜索 |
| 修改固件代码 | Edit | 直接编辑 `.c/.h` 文件 |
| 生成修复报告 | Write | `reports/hil-fix-report-<date>.md` |

## 允许修改的固件文件

| 文件 | 说明 |
| --- | --- |
| `sensoracquire.c` | 传感器采集主逻辑 |
| `sensor_actual_service.c` | ActualTemp/ActualHumi 计算 |
| `sensor_analyze_service.c` | 偏差剔除、异常过滤 |
| `sensor_history_service.c` | 历史数据缓存与回退 |
| `sensor_read_service.c` | 数据读取 |
| `sensor_modbus_service.c` | Modbus 通信 |
| `sensor_value_state_service.c` | 值状态管理 |
| `sensor_deployment_service.c` | 安装位配置 |
| `sensor_poll_queue_service.c` | 轮询队列 |
| `sensor_driver.c` | 驱动层（谨慎） |

## 禁止修改的文件

- `applications/app/system/*` — 系统级代码
- `applications/app/alarm/*` — 告警模块
- `board/*` — 板级支持包
- `src/*` — RT-Thread 内核

## 执行约束

| 约束项 | 规则 |
| --- | --- |
| 最大自动修复轮次 | 3 轮 |
| 每轮修改前 | 必须输出：问题定位、拟修改文件、拟修改点 |
| 每轮修改后 | 必须确认：编译通过、只改了预期文件 |
| 编译失败 | 不进入烧录，直接输出编译错误 |
| 烧录失败 | 不进入测试，提示检查 J-Link 连接 |
| 设备不在线 | 等待 30 秒重试，最多 3 次 |
| 修改了禁止范围文件 | 立即停止，回滚修改 |
| 连续 3 次相同失败原因 | 停止，输出人工介入报告 |

## Workflow 脚本结构

```javascript
export const meta = {
  name: 'hil-auto-fix',
  description: 'HIL 编译→烧录→测试→诊断→修复→复测 全自动闭环',
  phases: [
    { title: '构建烧录', detail: '编译固件并烧录到 GD32' },
    { title: '触发测试', detail: '通过 ATE API 执行传感器测试' },
    { title: '诊断修复', detail: '分析失败原因并修改固件源码（仅 FAIL 时执行）' },
    { title: '复测验证', detail: '重新编译烧录并验证修复结果' },
  ],
}

// Phase 1: 构建烧录
phase('构建烧录')
const buildResult = await agent(
  '执行以下步骤：\n' +
  '1. node scripts/hil/build-firmware.js\n' +
  '2. 如果编译失败，输出错误并停止\n' +
  '3. node scripts/hil/flash-firmware.js\n' +
  '4. node scripts/hil/check-device-online.js',
  { label: 'build-flash', phase: '构建烧录' }
)

// Phase 2: 触发测试
phase('触发测试')
const testResult = await agent(
  '执行以下步骤：\n' +
  '1. node scripts/run-hil-test-runner.js --case T-READ-001\n' +
  '2. 输出测试结果（PASS/FAIL）和报告路径',
  { label: 'run-test', phase: '触发测试' }
)

// Phase 3: 诊断修复（条件执行）
if (testResult.includes('FAIL')) {
  phase('诊断修复')
  const diagnosis = await agent(
    '执行以下步骤：\n' +
    '1. 读取 logs/last_test_error.json\n' +
    '2. 读取传感器相关固件源码\n' +
    '3. 分析失败根因\n' +
    '4. 输出：问题定位、拟修改文件、拟修改点\n' +
    '5. 修改固件源码并保存',
    { label: 'diagnose-fix', phase: '诊断修复' }
  )

  // Phase 4: 复测验证
  phase('复测验证')
  await agent(
    '执行以下步骤：\n' +
    '1. node scripts/hil/build-firmware.js\n' +
    '2. node scripts/hil/flash-firmware.js\n' +
    '3. node scripts/hil/check-device-online.js\n' +
    '4. node scripts/run-hil-test-runner.js --case T-READ-001\n' +
    '5. 输出最终结果',
    { label: 'retest', phase: '复测验证' }
  )
}
```
