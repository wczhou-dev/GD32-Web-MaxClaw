<!--
  SensorTest.vue: P1 传感器自动测试页面
  功能：展示传感器测试场景列表、执行测试、查看结果和报告
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
        <el-tag type="info" size="small">v1.0</el-tag>
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
      <el-input v-model="deviceKey" placeholder="设备地址" style="width: 200px;" :disabled="running" />
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
          <div v-for="cat in categories" :key="cat" class="category-group">
            <div class="category-header" @click="toggleCategory(cat)">
              <i :class="expandedCats.includes(cat) ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right'"></i>
              <span>{{ cat }}</span>
              <el-tag size="small" type="info">{{ getCatScenarios(cat).length }}</el-tag>
            </div>
            <div v-show="expandedCats.includes(cat)" class="category-items">
              <div v-for="s in getCatScenarios(cat)" :key="s.id"
                class="scenario-item"
                :class="{ selected: selectedIds.includes(s.id), running: runningId === s.id, pass: resultMap[s.id] === 'pass', fail: resultMap[s.id] === 'fail' }"
                @click="toggleSelect(s.id)"
              >
                <el-checkbox :model-value="selectedIds.includes(s.id)" @click.stop @change="toggleSelect(s.id)" :disabled="running" />
                <div class="scenario-info">
                  <div class="scenario-name">
                    <el-tag :type="s.priority === 'P0' ? 'danger' : 'warning'" size="small">{{ s.priority }}</el-tag>
                    {{ s.name }}
                  </div>
                  <div class="scenario-id">{{ s.id }}</div>
                </div>
                <div class="scenario-status">
                  <i v-if="runningId === s.id" class="fa-solid fa-spinner fa-spin" style="color: #1890ff;"></i>
                  <i v-else-if="resultMap[s.id] === 'pass'" class="fa-solid fa-circle-check" style="color: #52c41a;"></i>
                  <i v-else-if="resultMap[s.id] === 'fail'" class="fa-solid fa-circle-xmark" style="color: #ff4d4f;"></i>
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
          <div class="summary-card rate">
            <div class="summary-number">{{ batchResult.total > 0 ? ((batchResult.passed / batchResult.total) * 100).toFixed(0) : 0 }}%</div>
            <div class="summary-label">通过率</div>
          </div>
        </div>

        <!-- 断言明细表格 -->
        <div v-if="currentResult" class="detail-section">
          <h3>{{ currentResult.scenarioId }} - {{ currentResult.scenarioName }}</h3>
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
          <div class="log-header">运行日志</div>
          <div class="log-content" ref="logRef">
            <div v-for="(log, i) in logs" :key="i" :class="['log-line', log.level]">{{ log.text }}</div>
          </div>
        </div>

        <!-- 报告列表 -->
        <div class="report-section">
          <div class="report-header">
            <span>历史报告</span>
            <el-button size="small" @click="loadReports">刷新</el-button>
          </div>
          <el-table :data="reports" stripe size="small" max-height="200">
            <el-table-column prop="fileName" label="文件名" min-width="200" show-overflow-tooltip />
            <el-table-column label="创建时间" width="180">
              <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button size="small" type="primary" link @click="downloadReport(row.fileName)">下载</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick, computed } from 'vue'
import { VideoPlay, VideoPause } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

// ============================================================
// 响应式数据
// ============================================================

const scenarios = ref([])
const selectedIds = ref([])
const selectAll = ref(false)
const fieldType = ref('A')
const deviceKey = ref('192.168.10.233:502:1')
const running = ref(false)
const runningId = ref(null)
const batchResult = ref(null)
const currentResult = ref(null)
const resultMap = reactive({})
const logs = ref([])
const reports = ref([])
const logRef = ref(null)
const expandedCats = ref(['正常抄读', '异常过滤', '历史回退', '配置热更新', '综合场景'])

// ============================================================
// 计算属性
// ============================================================

const categories = computed(() => {
  const cats = new Set(scenarios.value.map(s => s.category))
  return Array.from(cats)
})

// ============================================================
// 方法
// ============================================================

function getCatScenarios(cat) {
  return scenarios.value.filter(s => s.category === cat)
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
  selectedIds.value = val ? scenarios.value.map(s => s.id) : []
}

function addLog(text, level = 'info') {
  logs.value.push({ text: `[${new Date().toLocaleTimeString()}] ${text}`, level })
  nextTick(() => {
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  })
}

function formatValue(val) {
  if (val == null) return '-'
  if (typeof val === 'number') return val.toFixed(2)
  return String(val)
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
      addLog(`加载 ${data.scenarios.length} 个测试场景`)
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
    }
  } catch (err) {
    addLog(`加载报告失败: ${err.message}`, 'error')
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
  await runScenarios(scenarios.value.map(s => s.id))
}

async function runP0Only() {
  const p0Ids = scenarios.value.filter(s => s.priority === 'P0').map(s => s.id)
  await runScenarios(p0Ids)
}

async function runScenarios(ids) {
  running.value = true
  batchResult.value = null
  currentResult.value = null
  for (const id of ids) resultMap[id] = null
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
      addLog(`测试任务已提交: ${data.taskId}`)
      // 轮询等待结果（简化版，实际应通过 WebSocket）
      await pollResult(data.taskId)
    } else {
      addLog(`提交失败: ${data.error}`, 'error')
    }
  } catch (err) {
    addLog(`执行异常: ${err.message}`, 'error')
  } finally {
    running.value = false
    runningId.value = null
  }
}

async function pollResult(taskId) {
  // 简化实现：轮询报告列表等待新报告出现
  const startTime = Date.now()
  const maxWait = 600000  // 10 分钟
  let lastReportCount = reports.value.length

  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, 3000))
    await loadReports()

    if (reports.value.length > lastReportCount) {
      // 新报告出现
      const newReport = reports.value[0]  // 最新的
      addLog(`测试完成，报告: ${newReport.fileName}`)

      // 加载报告详情
      try {
        const resp = await fetch(`/api/sensor-test/reports/${newReport.fileName}`)
        const report = await resp.json()
        if (report.summary) {
          batchResult.value = report.summary
          for (const s of report.scenarios || []) {
            resultMap[s.scenarioId] = s.conclusion === '通过' ? 'pass' : 'fail'
          }
          // 默认选中第一个场景的结果
          if (report.scenarios && report.scenarios.length > 0) {
            currentResult.value = {
              scenarioId: report.scenarios[0].scenarioId,
              scenarioName: report.scenarios[0].scenarioName,
              assertions: report.scenarios[0].assertions || [],
            }
          }
          addLog(`汇总: ${report.summary.passed}/${report.summary.total} 通过, 通过率 ${report.summary.passRate}`)
        }
      } catch (e) {
        addLog(`加载报告详情失败: ${e.message}`, 'error')
      }
      return
    }
    addLog('等待测试完成...')
  }

  addLog('等待超时', 'error')
}

function stopRun() {
  running.value = false
  addLog('已停止', 'warn')
}

function downloadReport(fileName) {
  window.open(`/api/sensor-test/reports/${fileName}`, '_blank')
}

// ============================================================
// 生命周期
// ============================================================

onMounted(() => {
  loadScenarios()
  loadReports()
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

.toolbar {
  background: white;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #e8e8e8;
}
.toolbar-spacer { flex: 1; }

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 左侧场景面板 */
.scenario-panel {
  width: 360px;
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
.scenario-info { flex: 1; min-width: 0; }
.scenario-name { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.scenario-id { font-size: 11px; color: #999; margin-top: 2px; }

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
.summary-card.rate { background: #e6f7ff; }
.summary-card.rate .summary-number { color: #1890ff; }
.summary-number { font-size: 28px; font-weight: bold; }
.summary-label { font-size: 12px; color: #999; margin-top: 4px; }

.detail-section {
  padding: 12px 16px;
  background: white;
  border-bottom: 1px solid #e8e8e8;
}
.detail-section h3 { font-size: 14px; margin-bottom: 8px; }

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
