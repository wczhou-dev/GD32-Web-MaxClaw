<!--
  SensorTest.vue: P1 传感器自动测试页面
  功能：展示传感器测试场景列表、执行测试、查看结果和报告
  v2.0 - 支持分组展示、WebSocket 实时状态、运行控制、断言详情、跳过显示
-->
<template>
  <div class="sensor-test-page">
    <!-- 标题栏 -->
    <div class="title-bar">
      <div class="title-left">
        <i class="fa-solid fa-temperature-half"></i>
        <span>P1 传感器自动测试</span>
      </div>
      <div class="title-right">
        <el-tag type="info" size="small">v2.0</el-tag>
        <el-tag :type="wsConnected ? 'success' : 'danger'" size="small" style="margin-left: 8px;">
          {{ wsConnected ? 'WS 已连接' : 'WS 未连接' }}
        </el-tag>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <el-button type="primary" @click="runSelected" :disabled="running || selectedIds.length === 0">
        <el-icon><VideoPlay /></el-icon>
        运行选中 ({{ selectedIds.length }})
      </el-button>
      <el-button @click="runAll" :disabled="running">
        <el-icon><VideoPlay /></el-icon>
        运行全部
      </el-button>
      <el-button @click="runP0Only" :disabled="running">
        <el-icon><VideoPlay /></el-icon>
        仅运行 P0
      </el-button>
      <el-divider direction="vertical" />
      <el-button @click="stopRun" :disabled="!running" type="danger">
        <el-icon><VideoPause /></el-icon>
        停止
      </el-button>
      <div class="toolbar-spacer" />
      <el-select v-model="fieldType" placeholder="场区类型" style="width: 120px;" :disabled="running">
        <el-option label="标准场区 (A)" value="A" />
        <el-option label="佛山三水 (B)" value="B" />
        <el-option label="大王场区 (C)" value="C" />
      </el-select>
      <!-- FE-SENSOR-008: 设备下拉选择 -->
      <el-select v-model="deviceKey" placeholder="选择设备" style="width: 220px;" :disabled="running" filterable allow-create>
        <el-option v-for="d in deviceList" :key="d.key" :label="`${d.name || d.ip} (${d.ip}:${d.port})`" :value="`${d.ip}:${d.port}:${d.unitId}`" />
      </el-select>
    </div>

    <!-- 进度条 -->
    <div v-if="running" class="progress-bar">
      <el-progress :percentage="progressPercent" :status="progressPercent >= 100 ? 'success' : ''" :stroke-width="8" />
      <span class="progress-text">{{ currentScenarioName || '准备中...' }} ({{ progressIndex + 1 }}/{{ progressTotal }})</span>
    </div>

    <!-- 主内容区 -->
    <div class="main-content">
      <!-- 左侧：场景列表 -->
      <div class="scenario-panel">
        <div class="panel-header">
          <span>测试场景 ({{ scenarios.length }})</span>
          <el-checkbox v-model="selectAll" @change="onSelectAll" :disabled="running">全选</el-checkbox>
        </div>
        <div class="scenario-list">
          <div v-for="group in pageGroups" :key="group" class="category-group">
            <div class="category-header" @click="toggleCategory(group)">
              <i :class="expandedCats.includes(group) ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
              <span>{{ group }}</span>
              <el-tag size="small" type="info">{{ getGroupScenarios(group).length }}</el-tag>
              <el-tag v-if="group === '前置检查'" size="small" type="warning" style="margin-left: 4px;">自动</el-tag>
            </div>
            <div v-show="expandedCats.includes(group)" class="category-items">
              <div v-for="s in getGroupScenarios(group)" :key="s.id"
                class="scenario-item"
                :class="{
                  selected: selectedIds.includes(s.id),
                  running: runningId === s.id,
                  pass: resultMap[s.testId || s.id] === 'pass',
                  fail: resultMap[s.testId || s.id] === 'fail',
                  skip: resultMap[s.testId || s.id] === 'skip',
                  error: resultMap[s.testId || s.id] === 'error',
                }"
                @click="toggleSelect(s.id)"
              >
                <el-checkbox :model-value="selectedIds.includes(s.id)" @click.stop @change="toggleSelect(s.id)" :disabled="running || s.type === 'pre-check'" />
                <div class="scenario-info">
                  <div class="scenario-name">
                    <el-tag :type="s.priority === 'P0' ? 'danger' : 'warning'" size="small">{{ s.priority }}</el-tag>
                    <el-tag v-if="s.isP1Required" type="success" size="small">必测</el-tag>
                    {{ s.name }}
                  </div>
                  <div class="scenario-meta">
                    <span class="scenario-id">{{ s.testId || s.id }}</span>
                    <span v-if="s.estimatedSeconds" class="scenario-time">
                      <i class="fa-regular fa-clock"></i> ~{{ formatDuration(s.estimatedSeconds) }}
                    </span>
                    <span v-if="s.dependencies && s.dependencies.length" class="scenario-deps">
                      依赖: {{ s.dependencies.join(', ') }}
                    </span>
                  </div>
                </div>
                <div class="scenario-status">
                  <i v-if="runningId === s.id" class="fa-solid fa-spinner fa-spin" style="color: #1890ff;"></i>
                  <i v-else-if="resultMap[s.testId || s.id] === 'pass'" class="fa-solid fa-circle-check" style="color: #52c41a;"></i>
                  <i v-else-if="resultMap[s.testId || s.id] === 'fail'" class="fa-solid fa-circle-xmark" style="color: #ff4d4f;"></i>
                  <i v-else-if="resultMap[s.testId || s.id] === 'skip'" class="fa-solid fa-forward" style="color: #faad14;"></i>
                  <i v-else-if="resultMap[s.testId || s.id] === 'error'" class="fa-solid fa-triangle-exclamation" style="color: #ff4d4f;"></i>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：结果详情 -->
      <div class="result-panel">
        <div class="panel-header">
          <span>测试结果</span>
          <el-tag v-if="batchResult" :type="batchResult.failed === 0 ? 'success' : 'danger'" size="small">
            {{ batchResult.passed }}/{{ batchResult.total }} 通过
          </el-tag>
        </div>

        <!-- 汇总卡片 -->
        <div v-if="batchResult" class="summary-cards">
          <div class="summary-card">
            <div class="summary-number">{{ batchResult.total }}</div>
            <div class="summary-label">总场景</div>
          </div>
          <div class="summary-card pass">
            <div class="summary-number">{{ batchResult.passed }}</div>
            <div class="summary-label">通过</div>
          </div>
          <div class="summary-card fail">
            <div class="summary-number">{{ batchResult.failed }}</div>
            <div class="summary-label">失败</div>
          </div>
          <div class="summary-card skip" v-if="batchResult.skipped">
            <div class="summary-number">{{ batchResult.skipped }}</div>
            <div class="summary-label">跳过</div>
          </div>
          <div class="summary-card rate">
            <div class="summary-number">{{ passRate }}%</div>
            <div class="summary-label">通过率</div>
          </div>
        </div>

        <!-- 断言明细表格 -->
        <div v-if="currentResult" class="detail-section">
          <div class="detail-header">
            <h3>{{ currentResult.scenarioId }} - {{ currentResult.scenarioName }}</h3>
            <el-tag :type="currentResult.status === 'pass' ? 'success' : currentResult.status === 'skip' ? 'warning' : 'danger'" size="small">
              {{ currentResult.status === 'pass' ? '通过' : currentResult.status === 'skip' ? '跳过' : '失败' }}
            </el-tag>
          </div>
          <div v-if="currentResult.skipReason" class="skip-banner">
            <i class="fa-solid fa-forward"></i>
            跳过原因: {{ skipReasonText(currentResult.skipReason) }}
          </div>
          <el-table :data="currentResult.assertions || []" stripe size="small" max-height="400">
            <el-table-column label="#" width="50" type="index" />
            <el-table-column label="结果" width="80">
              <template #default="{ row }">
                <el-tag :type="row.pass ? 'success' : 'danger'" size="small">{{ row.pass ? '通过' : '失败' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="message" label="描述" min-width="200" show-overflow-tooltip />
            <el-table-column label="期望值" width="120">
              <template #default="{ row }">{{ formatValue(row.expected) }}</template>
            </el-table-column>
            <el-table-column label="实际值" width="120">
              <template #default="{ row }">{{ formatValue(row.actual) }}</template>
            </el-table-column>
            <el-table-column label="容差" width="80">
              <template #default="{ row }">{{ row.tolerance != null ? row.tolerance : '-' }}</template>
            </el-table-column>
            <el-table-column prop="code" label="错误码" width="160" show-overflow-tooltip />
          </el-table>
        </div>

        <!-- 运行日志 -->
        <div class="log-section">
          <div class="log-header">
            <span>运行日志</span>
            <el-button size="small" text @click="clearLogs">清空</el-button>
          </div>
          <div class="log-content" ref="logRef">
            <div v-for="(log, i) in logs" :key="i" :class="['log-line', log.level]">{{ log.text }}</div>
          </div>
        </div>

        <!-- 报告列表 -->
        <div class="report-section">
          <div class="report-header">
            <span>历史报告</span>
            <div>
              <el-select v-model="reportFilter" size="small" style="width: 100px; margin-right: 8px;" @change="filterReports">
                <el-option label="全部" value="all" />
                <el-option label="批量" value="sensor-batch" />
                <el-option label="单项" value="sensor-test" />
              </el-select>
              <el-button size="small" @click="loadReports">刷新</el-button>
            </div>
          </div>
          <el-table :data="filteredReports" stripe size="small" max-height="200">
            <el-table-column label="类型" width="60">
              <template #default="{ row }">
                <el-tag :type="row.summary?.type === 'sensor-batch' ? 'primary' : 'info'" size="small">
                  {{ row.summary?.type === 'sensor-batch' ? '批量' : '单项' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="fileName" label="文件名" min-width="180" show-overflow-tooltip />
            <el-table-column label="通过率" width="80">
              <template #default="{ row }">
                <span v-if="row.summary?.passRate" :style="{ color: row.summary.passRate === '100.0%' ? '#52c41a' : '#ff4d4f' }">
                  {{ row.summary.passRate }}
                </span>
                <span v-else-if="row.summary?.conclusion">{{ row.summary.conclusion }}</span>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column label="场区" width="50">
              <template #default="{ row }">{{ row.summary?.fieldType || '-' }}</template>
            </el-table-column>
            <el-table-column label="创建时间" width="160">
              <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button size="small" type="primary" link @click="downloadReport(row.fileName)">JSON</el-button>
                <el-button size="small" type="success" link @click="downloadHtmlReport(row.fileName)">HTML</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, nextTick, computed } from 'vue'
import { VideoPlay, VideoPause } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

// ============================================================
// 响应式数据
// ============================================================

const scenarios = ref([])
const selectedIds = ref([])
const selectAll = ref(false)
const fieldType = ref('A')
const deviceKey = ref('192.168.10.233:502:1')
const deviceList = ref([]) // FE-SENSOR-008
const running = ref(false)
const runningId = ref(null)
const batchResult = ref(null)
const currentResult = ref(null)
const resultMap = reactive({})
const logs = ref([])
const reports = ref([])
const logRef = ref(null)
const expandedCats = ref(['前置检查', '正常抄读', '异常过滤', '历史回退', '配置热更新', '综合场景'])
const wsConnected = ref(false)
const currentTaskId = ref(null)
const reportFilter = ref('all') // FE-SENSOR-007
const filteredReports = ref([])

// 进度
const progressPercent = ref(0)
const progressIndex = ref(0)
const progressTotal = ref(0)
const currentScenarioName = ref('')

// WebSocket
let ws = null
let wsReconnectTimer = null

// ============================================================
// 计算属性
// ============================================================

const pageGroups = computed(() => {
  const groupOrder = ['前置检查', '正常抄读', '异常过滤', '历史回退', '配置热更新', '综合场景']
  const groups = new Set(scenarios.value.map(s => s.group || s.category))
  return groupOrder.filter(g => groups.has(g))
})

const passRate = computed(() => {
  if (!batchResult.value || batchResult.value.total === 0) return 0
  return ((batchResult.value.passed / batchResult.value.total) * 100).toFixed(0)
})

// ============================================================
// 方法
// ============================================================

function getGroupScenarios(group) {
  return scenarios.value.filter(s => (s.group || s.category) === group)
}

function toggleCategory(cat) {
  const idx = expandedCats.value.indexOf(cat)
  if (idx >= 0) expandedCats.value.splice(idx, 1)
  else expandedCats.value.push(cat)
}

function toggleSelect(id) {
  if (running.value) return
  const idx = selectedIds.value.indexOf(id)
  if (idx >= 0) selectedIds.value.splice(idx, 1)
  else selectedIds.value.push(id)
}

function onSelectAll(val) {
  if (running.value) return
  selectedIds.value = val ? scenarios.value.filter(s => s.type !== 'pre-check').map(s => s.id) : []
}

function addLog(text, level = 'info') {
  logs.value.push({ text: `[${new Date().toLocaleTimeString()}] ${text}`, level })
  nextTick(() => {
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  })
}

function clearLogs() {
  logs.value = []
}

function formatValue(val) {
  if (val == null) return '-'
  if (typeof val === 'number') return val.toFixed(2)
  return String(val)
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}秒`
  const min = Math.floor(seconds / 60)
  const sec = seconds % 60
  return sec > 0 ? `${min}分${sec}秒` : `${min}分钟`
}

function skipReasonText(reason) {
  const map = {
    'not_installed_masked': '传感器未安装（已屏蔽）',
    'field_not_configured': '场区未配置',
    'hardware_missing': '硬件资源缺失',
    'dependency_failed': '前置依赖失败',
  }
  return map[reason] || reason
}

// FE-SENSOR-009: 检查是否包含长耗时场景
function hasLongDurationScenarios(ids) {
  const longDurationThreshold = 120 // 2 分钟
  return ids.some(id => {
    const s = scenarios.value.find(sc => sc.id === id)
    return s && s.estimatedSeconds > longDurationThreshold
  })
}

function getEstimatedTotalTime(ids) {
  let total = 0
  for (const id of ids) {
    const s = scenarios.value.find(sc => sc.id === id)
    if (s && s.estimatedSeconds) total += s.estimatedSeconds
  }
  return total
}

// ============================================================
// API 调用
// ============================================================

async function loadScenarios() {
  try {
    const resp = await fetch('/api/sensor-test/scenarios')
    const data = await resp.json()
    if (data.success) {
      scenarios.value = data.scenarios
      addLog(`加载 ${data.scenarios.length} 个测试场景 (${data.scenarios.filter(s => s.isP1Required).length} 个 P1 必测)`)
    }
  } catch (err) {
    addLog(`加载场景失败: ${err.message}`, 'error')
  }
}

async function loadReports() {
  try {
    const resp = await fetch('/api/sensor-test/reports')
    const data = await resp.json()
    if (data.success) {
      reports.value = data.reports
      filterReports()
    }
  } catch (err) {
    addLog(`加载报告失败: ${err.message}`, 'error')
  }
}

// FE-SENSOR-007: 报告过滤
function filterReports() {
  if (reportFilter.value === 'all') {
    filteredReports.value = reports.value
  } else {
    filteredReports.value = reports.value.filter(r => r.summary?.type === reportFilter.value)
  }
}

function downloadReport(fileName) {
  window.open(`/api/sensor-test/reports/${fileName}`, '_blank')
}

// FE-SENSOR-007: HTML 报告下载
function downloadHtmlReport(fileName) {
  const htmlName = fileName.replace('.json', '.html')
  window.open(`/api/sensor-test/reports/${htmlName}`, '_blank')
}

// FE-SENSOR-008: 加载设备列表
async function loadDevices() {
  try {
    const resp = await fetch('/api/devices')
    const data = await resp.json()
    if (data.success && data.devices) {
      deviceList.value = data.devices
      if (data.devices.length > 0 && !deviceKey.value) {
        const d = data.devices[0]
        deviceKey.value = `${d.ip}:${d.port}:${d.unitId}`
      }
    }
  } catch (err) {
    addLog(`加载设备列表失败: ${err.message}`, 'error')
  }
}

async function runSelected() {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先选择测试场景')
    return
  }
  await runScenarios(selectedIds.value)
}

async function runAll() {
  const ids = scenarios.value.filter(s => s.type !== 'pre-check').map(s => s.id)
  await runScenarios(ids)
}

async function runP0Only() {
  const p0Ids = scenarios.value.filter(s => s.priority === 'P0' && s.type !== 'pre-check').map(s => s.id)
  await runScenarios(p0Ids)
}

async function runScenarios(ids) {
  // FE-SENSOR-009: 长耗时提示
  const totalTime = getEstimatedTotalTime(ids)
  if (hasLongDurationScenarios(ids)) {
    try {
      await ElMessageBox.confirm(
        `所选场景包含长耗时测试项（ErMax/历史回退等），预计总耗时约 ${formatDuration(totalTime)}。是否继续？`,
        '长耗时提示',
        { confirmButtonText: '继续执行', cancelButtonText: '取消', type: 'warning' }
      )
    } catch (_) {
      return // 用户取消
    }
  }

  running.value = true
  batchResult.value = null
  currentResult.value = null
  progressPercent.value = 0
  progressIndex.value = 0
  progressTotal.value = ids.length
  currentScenarioName.value = ''
  for (const id of ids) {
    const s = scenarios.value.find(sc => sc.id === id)
    resultMap[s?.testId || id] = null
  }
  addLog(`开始执行 ${ids.length} 个场景...`)

  try {
    const resp = await fetch('/api/sensor-test/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenarioIds: ids,
        deviceKey: deviceKey.value,
        fieldType: fieldType.value,
      }),
    })
    const data = await resp.json()
    if (data.success) {
      currentTaskId.value = data.taskId
      addLog(`测试任务已提交: ${data.taskId}`)
      // WebSocket 会推送进度和结果，轮询作为兜底
      await pollResult(data.taskId)
    } else {
      addLog(`提交失败: ${data.error}`, 'error')
    }
  } catch (err) {
    addLog(`执行异常: ${err.message}`, 'error')
  } finally {
    running.value = false
    runningId.value = null
    currentTaskId.value = null
  }
}

async function pollResult(taskId) {
  // 兜底轮询：WebSocket 断开时使用
  const startTime = Date.now()
  const maxWait = 600000

  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, 5000))

    // 如果 WebSocket 已经处理了结果，跳过轮询
    if (!running.value) return

    // 尝试查询任务状态
    try {
      const resp = await fetch(`/api/sensor-test/tasks/${taskId}`)
      const data = await resp.json()
      if (data.success && data.task) {
        const task = data.task
        if (task.status === 'pass' || task.status === 'fail' || task.status === 'error' || task.status === 'stopped') {
          // 任务完成，加载报告
          if (task.reportFile) {
            await loadReportDetail(task.reportFile)
          }
          return
        }
        // 更新进度
        if (task.currentIndex != null) {
          progressIndex.value = task.currentIndex
          progressPercent.value = Math.round((task.currentIndex / (task.scenarioIds?.length || 1)) * 100)
        }
      }
    } catch (_) {
      // 任务状态接口可能不存在，忽略
    }

    // 兜底：检查报告列表
    await loadReports()
    addLog('等待测试完成...')
  }

  addLog('等待超时', 'error')
}

async function loadReportDetail(fileName) {
  try {
    const resp = await fetch(`/api/sensor-test/reports/${fileName}`)
    const report = await resp.json()
    if (report.summary) {
      batchResult.value = report.summary
      for (const s of report.scenarios || []) {
        resultMap[s.scenarioId] = s.conclusion === '通过' ? 'pass' : s.conclusion === '跳过' ? 'skip' : 'fail'
      }
      if (report.scenarios && report.scenarios.length > 0) {
        currentResult.value = {
          scenarioId: report.scenarios[0].scenarioId,
          scenarioName: report.scenarios[0].scenarioName,
          status: report.scenarios[0].conclusion === '通过' ? 'pass' : 'fail',
          assertions: report.scenarios[0].assertions || [],
        }
      }
      addLog(`汇总: ${report.summary.passed}/${report.summary.total} 通过, 通过率 ${report.summary.passRate}`)
    }
  } catch (e) {
    addLog(`加载报告详情失败: ${e.message}`, 'error')
  }
}

async function stopRun() {
  if (currentTaskId.value) {
    try {
      await fetch('/api/sensor-test/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: currentTaskId.value }),
      })
    } catch (_) {}
  }
  running.value = false
  addLog('已发送停止请求', 'warn')
}

// ============================================================
// WebSocket
// ============================================================

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}`

  try {
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      wsConnected.value = true
      addLog('WebSocket 已连接', 'info')
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleWsMessage(msg)
      } catch (_) {}
    }

    ws.onclose = () => {
      wsConnected.value = false
      // 自动重连
      wsReconnectTimer = setTimeout(connectWebSocket, 3000)
    }

    ws.onerror = () => {
      wsConnected.value = false
    }
  } catch (_) {
    wsConnected.value = false
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'sensor_test_started':
      if (msg.taskId === currentTaskId.value) {
        addLog(`测试开始: ${msg.total} 个场景`)
      }
      break

    case 'sensor_test_progress':
      if (msg.taskId === currentTaskId.value) {
        progressIndex.value = msg.index || 0
        progressTotal.value = msg.total || progressTotal.value
        progressPercent.value = msg.progress || Math.round((msg.index / msg.total) * 100)
        currentScenarioName.value = msg.scenarioId || ''
        runningId.value = msg.scenarioId || null
        addLog(`进度: ${msg.scenarioId} (${msg.index + 1}/${msg.total})`)
      }
      break

    case 'sensor_test_scenario_finished':
      if (msg.taskId === currentTaskId.value) {
        const status = msg.status
        resultMap[msg.scenarioId] = status
        addLog(`完成: ${msg.scenarioId} → ${status === 'pass' ? '通过' : status === 'fail' ? '失败' : status}`, status === 'pass' ? 'info' : 'error')

        // 更新当前结果
        if (msg.assertions) {
          currentResult.value = {
            scenarioId: msg.scenarioId,
            scenarioName: scenarios.value.find(s => s.id === msg.scenarioId || s.testId === msg.scenarioId)?.name || msg.scenarioId,
            status,
            assertions: msg.assertions,
          }
        }
      }
      break

    case 'sensor_test_finished':
      if (msg.taskId === currentTaskId.value) {
        if (msg.result?.stopped) {
          addLog('测试已停止', 'warn')
        } else {
          addLog(`测试完成: ${msg.result?.passed || 0}/${msg.result?.total || 0} 通过`)
          if (msg.result?.reportFile) {
            loadReportDetail(msg.result.reportFile)
          }
        }
        running.value = false
        runningId.value = null
      }
      break

    case 'sensor_test_error':
      if (msg.taskId === currentTaskId.value) {
        addLog(`测试异常: ${msg.error}`, 'error')
        running.value = false
        runningId.value = null
      }
      break
  }
}

// ============================================================
// 生命周期
// ============================================================

onMounted(() => {
  loadScenarios()
  loadReports()
  loadDevices()
  connectWebSocket()
})

onUnmounted(() => {
  if (ws) {
    ws.close()
    ws = null
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer)
  }
})
</script>

<style scoped>
.sensor-test-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 80px);
  background: #f5f5f5;
  border-radius: 8px;
  overflow: hidden;
}

.title-bar {
  background: linear-gradient(135deg, #1890ff, #096dd9);
  color: white;
  padding: 12px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 16px;
  font-weight: 600;
}
.title-bar .title-left { display: flex; align-items: center; gap: 8px; }
.title-bar .title-right { display: flex; align-items: center; gap: 8px; }

.toolbar {
  background: white;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #e8e8e8;
}
.toolbar-spacer { flex: 1; }

.progress-bar {
  background: white;
  padding: 8px 16px;
  border-bottom: 1px solid #e8e8e8;
}
.progress-text {
  font-size: 12px;
  color: #666;
  margin-top: 4px;
  display: block;
}

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 左侧场景面板 */
.scenario-panel {
  width: 400px;
  background: white;
  border-right: 1px solid #e8e8e8;
  display: flex;
  flex-direction: column;
}
.panel-header {
  padding: 10px 16px;
  border-bottom: 1px solid #e8e8e8;
  font-weight: 600;
  font-size: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fafafa;
}
.scenario-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.category-header {
  padding: 8px 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  color: #666;
  background: #f9f9f9;
  border-bottom: 1px solid #f0f0f0;
}
.category-header:hover { background: #f0f7ff; }
.scenario-item {
  padding: 8px 16px 8px 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  border-bottom: 1px solid #f5f5f5;
  transition: background 0.2s;
}
.scenario-item:hover { background: #f0f7ff; }
.scenario-item.selected { background: #e6f7ff; }
.scenario-item.running { background: #fff7e6; }
.scenario-item.pass { border-left: 3px solid #52c41a; }
.scenario-item.fail { border-left: 3px solid #ff4d4f; }
.scenario-item.skip { border-left: 3px solid #faad14; }
.scenario-item.error { border-left: 3px solid #ff4d4f; background: #fff2f0; }
.scenario-info { flex: 1; min-width: 0; }
.scenario-name { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.scenario-meta {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.scenario-id { color: #999; }
.scenario-time { color: #1890ff; }
.scenario-deps { color: #faad14; }

/* 右侧结果面板 */
.result-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.summary-cards {
  display: flex;
  gap: 16px;
  padding: 12px 16px;
  background: white;
  border-bottom: 1px solid #e8e8e8;
}
.summary-card {
  flex: 1;
  text-align: center;
  padding: 12px;
  border-radius: 8px;
  background: #f9f9f9;
}
.summary-card.pass { background: #f6ffed; }
.summary-card.pass .summary-number { color: #52c41a; }
.summary-card.fail { background: #fff2f0; }
.summary-card.fail .summary-number { color: #ff4d4f; }
.summary-card.skip { background: #fffbe6; }
.summary-card.skip .summary-number { color: #faad14; }
.summary-card.rate { background: #e6f7ff; }
.summary-card.rate .summary-number { color: #1890ff; }
.summary-number { font-size: 28px; font-weight: bold; }
.summary-label { font-size: 12px; color: #999; margin-top: 4px; }

.detail-section {
  padding: 12px 16px;
  background: white;
  border-bottom: 1px solid #e8e8e8;
}
.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.detail-header h3 { font-size: 14px; margin: 0; }
.skip-banner {
  background: #fffbe6;
  border: 1px solid #ffe58f;
  border-radius: 4px;
  padding: 8px 12px;
  margin-bottom: 8px;
  font-size: 13px;
  color: #d48806;
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 150px;
}
.log-header {
  padding: 6px 16px;
  background: #333;
  color: #aaa;
  font-size: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.log-content {
  flex: 1;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 8px 16px;
  font-family: 'Consolas', monospace;
  font-size: 12px;
  overflow-y: auto;
  line-height: 1.6;
}
.log-line.error { color: #f44747; }
.log-line.warn { color: #cca700; }

.report-section {
  background: white;
  border-top: 1px solid #e8e8e8;
  max-height: 250px;
  overflow-y: auto;
}
.report-header {
  padding: 8px 16px;
  font-weight: 600;
  font-size: 13px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #f0f0f0;
}
</style>
