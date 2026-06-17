<template>
  <div class="ate-page-container">
    <!-- 顶部标题栏 (蓝色渐变) -->
    <div class="win-title-bar">
      <div class="title-left">
        <i class="fa-solid fa-microchip"></i>
        <span>智能环控器自动化综合检定系统V1.0</span>
      </div>
    </div>

    <!-- 经典工具栏 (Toolbar) -->
    <div class="win-toolbar">
      <!-- 检定项目视图的工具按钮 -->
      <template v-if="currentView === 'test'">
        <button class="win-btn" @click="startSingleTest" :disabled="testEngine.status === 'running'">
          <i class="fa-solid fa-play" style="color: #16a34a;"></i>
          <span>单步测试</span>
        </button>
        <button class="win-btn" @click="startContinuousTest" :disabled="testEngine.status === 'running'">
          <i class="fa-solid fa-forward-fast" style="color: #16a34a;"></i>
          <span>连续测试</span>
        </button>
        <button class="win-btn" @click="startFailedOnlyTest" :disabled="testEngine.status === 'running'">
          <i class="fa-solid fa-rotate-right" style="color: #ea580c;"></i>
          <span>测不合格项</span>
        </button>
        <div class="toolbar-divider"></div>
        <button class="win-btn" @click="stopTest" :disabled="testEngine.status !== 'running'">
          <i class="fa-solid fa-stop" style="color: #dc2626;"></i>
          <span>停止检定</span>
        </button>
        <button class="win-btn" @click="resetTest" :disabled="testEngine.status === 'running'">
          <i class="fa-solid fa-eraser" style="color: #4b5563;"></i>
          <span>重置状态</span>
        </button>
        <div class="toolbar-divider"></div>
        <button class="win-btn" @click="downloadReport" :disabled="testEngine.status === 'idle' || testEngine.status === 'running'">
          <i class="fa-solid fa-floppy-disk" style="color: #9333ea;"></i>
          <span>保存报表</span>
        </button>
      </template>

      <div class="toolbar-spacer"></div>

      <!-- 视图切换按钮 -->
      <button class="win-btn" :class="{ 'active': currentView === 'config' }" @click="currentView = 'config'">
        <i class="fa-solid fa-gears" style="color: #475569;"></i>
        <span>系统配置</span>
      </button>
      <button class="win-btn" :class="{ 'active': currentView === 'test' }" @click="currentView = 'test'">
        <i class="fa-solid fa-list-check" style="color: #3b82f6;"></i>
        <span>项目检定</span>
      </button>
      <button class="win-btn" :class="{ 'active': currentView === 'manual' }" @click="currentView = 'manual'">
        <i class="fa-solid fa-screwdriver-wrench" style="color: #d97706;"></i>
        <span>手动点检</span>
      </button>

      <div class="toolbar-divider"></div>

      <!-- 启用报文复选框 -->
      <div class="enable-log-btn" @click="toggleSerialConnection">
        <div class="win-btn">
          <i class="fa-solid fa-plug-circle-check" :class="enableRealtimeLogs ? 'text-green-600' : 'text-slate-500'"></i>
          <span :class="{ 'font-bold': enableRealtimeLogs }">启用报文</span>
        </div>
        <input type="checkbox" :checked="enableRealtimeLogs" class="checkbox">
      </div>
    </div>

    <!-- 主体内容区 -->
    <div class="ate-main-content">
      <!-- 视图一：检定项目工作台 -->
      <template v-if="currentView === 'test'">
        <!-- 左侧：检定项目树形控件 -->
        <div class="tree-panel">
          <div class="panel-header">
            <span class="panel-title">检定项目清单</span>
          </div>
          <div class="tree-container">
            <el-tree
              ref="treeRef"
              :data="testTree"
              show-checkbox
              node-key="id"
              default-expand-all
              :props="defaultProps"
            >
              <template #default="{ node, data }">
                <span class="tree-node-content">
                  <span>{{ node.label }}</span>
                  <span v-if="data.status" :class="getStatusColor(data.status)" class="status-badge">
                    {{ getStatusText(data.status) }}
                  </span>
                </span>
              </template>
            </el-tree>
          </div>
        </div>

        <!-- 右侧：数据监控区 -->
        <div class="right-panel">
          <!-- 右侧上部：实时寄存器监控表 -->
          <div class="register-panel" :style="{ height: registerPanelHeight + '%' }">
            <div class="panel-header">
              <span class="panel-title">检定信息</span>
              <span class="current-item">当前执行: {{ testEngine.currentItemName || '无' }}</span>
            </div>
            <div class="register-table-container">
              <el-table :data="activeDetailRegisters" border style="width: 100%" size="small" :row-class-name="tableRowClassName">
                <el-table-column prop="id" label="序号" width="50" align="center"></el-table-column>
                <el-table-column prop="name" label="检定项目" width="250"></el-table-column>
                <el-table-column prop="result" label="结果"></el-table-column>
              </el-table>
            </div>
          </div>

          <!-- 拖拽调节器 -->
          <div 
            class="panel-resizer" 
            :class="{ active: isResizing }" 
            @mousedown="startResize"
          ></div>

          <!-- 右侧下部：Tab 切换终端 -->
          <div class="terminal-panel">
            <!-- WinForms 风格 Tab 标签栏 -->
            <div class="terminal-tabs">
              <div
                @click="activeLogTab = 'system'"
                :class="['terminal-tab', { active: activeLogTab === 'system' }]"
              >
                测试系统运行日志
              </div>
              <div
                @click="activeLogTab = 'device'"
                :class="['terminal-tab', { active: activeLogTab === 'device' }]"
              >
                环控器运行日志
                <span v-if="enableRealtimeLogs" class="status-dot"></span>
              </div>
              <div class="tab-spacer"></div>
              <div class="tab-tools">
                <label class="auto-save-checkbox">
                  <input type="checkbox" v-model="autoSaveLogs" />
                  <span>自动保存日志</span>
                </label>
                <span v-if="autoSaveLogs" class="auto-save-tip">
                  <i class="fa-solid fa-circle-info"></i>
                  已保存至 logs/firmware_runtime.log
                </span>
                <span v-else class="auto-save-tip disabled">
                  <i class="fa-solid fa-circle-xmark"></i>
                  已关闭自动保存
                </span>
                <a href="#" @click.prevent="exportLogs" class="tool-link">
                  <i class="fa-solid fa-download"></i> 导出日志
                </a>
                <span class="tool-divider">|</span>
                <a href="#" @click.prevent="clearLogs" class="tool-link">
                  <i class="fa-solid fa-trash-can"></i> 清空终端
                </a>
              </div>
            </div>
            <!-- 终端内容区 -->
            <div class="terminal-content" :class="activeLogTab === 'system' ? 'terminal-system' : 'terminal-device'">
              <!-- 系统运行日志 (黑底) -->
              <div v-show="activeLogTab === 'system'" ref="systemTerminal" class="terminal-body">
                <div v-for="(log, idx) in systemLogs" :key="'sys'+idx" :style="{ color: log.styleColor }">
                  <span class="log-time">[{{ log.time }}]</span><span>{{ log.text }}</span>
                </div>
              </div>
              <!-- 环控器串口报文 (蓝底) -->
              <div v-show="activeLogTab === 'device'" ref="deviceTerminal" class="terminal-body">
                <div v-if="!enableRealtimeLogs" class="text-gray-400 italic mb-2">
                  请在上方工具栏勾选"启用报文"以通过浏览器 Web Serial API 监听物理串口数据...
                </div>
                <div v-for="(log, idx) in deviceLogs" :key="'dev'+idx" :style="{ color: log.styleColor }">
                  <span class="log-time">[{{ log.time }}]</span><span>{{ log.text }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 视图二：系统配置 -->
      <template v-if="currentView === 'config'">
        <div class="config-panel">
          <fieldset class="win-group">
            <legend>网络与通信接口绑定</legend>
            <div class="config-row">
              <label class="config-label">设备 IP 地址:</label>
              <el-input v-model="deviceIp" size="small" class="config-input"></el-input>
            </div>
            <div class="config-row">
              <label class="config-label rs485-label">RS485</label>
              <el-select v-model="comPorts.rs485" size="small" class="config-select">
                <el-option label="COM1" value="COM1"></el-option>
                <el-option label="COM3" value="COM3"></el-option>
                <el-option label="COM4" value="COM4"></el-option>
              </el-select>
              <el-select v-model="comPorts.baudRateRS485" size="small" class="config-select-sm">
                <el-option label="9600 bps" :value="9600"></el-option>
                <el-option label="115200 bps" :value="115200"></el-option>
              </el-select>
            </div>
            <div class="config-row">
              <label class="config-label rs485-label">环控日志</label>
              <el-select v-model="comPorts.log" size="small" class="config-select">
                <el-option label="COM1" value="COM1"></el-option>
                <el-option label="COM3" value="COM3"></el-option>
                <el-option label="COM4" value="COM4"></el-option>
                <el-option label="COM5" value="COM5"></el-option>
              </el-select>
              <el-select v-model="comPorts.baudRateLog" size="small" class="config-select-sm">
                <el-option label="9600 bps" :value="9600"></el-option>
                <el-option label="115200 bps" :value="115200"></el-option>
              </el-select>
            </div>
          </fieldset>

          <!-- 硬件端口拓扑示意图 -->
          <div class="hw-topo-container">
            <div class="hw-topo-board">
              <!-- 顶部 DI 输入 -->
              <div class="hw-di-row">
                <div class="hw-di-label">数字量输入</div>
                <div class="hw-di-items">
                  <div v-for="i in 24" :key="'di'+i" class="hw-port hw-di">
                    <span class="hw-port-name">DI{{ 25 - i }}</span>
                    <span class="hw-port-led"></span>
                  </div>
                </div>
              </div>

              <!-- 中部主体区域 -->
              <div class="hw-middle">
                <!-- 左侧 AI/AO -->
                <div class="hw-side-left">
                  <div class="hw-side-group">
                    <div class="hw-side-label hw-side-label-v">模拟输入</div>
                    <div class="hw-port-list">
                      <div v-for="i in 4" :key="'ai'+i" class="hw-port hw-io">
                        <span class="hw-port-led"></span>
                        <span class="hw-port-name">AI{{ i - 1 }}</span>
                      </div>
                    </div>
                  </div>
                  <div class="hw-side-group">
                    <div class="hw-side-label hw-side-label-v">模拟输出</div>
                    <div class="hw-port-list">
                      <div v-for="i in 4" :key="'ao'+i" class="hw-port hw-io">
                        <span class="hw-port-led"></span>
                        <span class="hw-port-name">AO{{ i - 1 }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 中央区域 -->
                <div class="hw-center">
                  <button class="hw-oneclick-btn hw-start" @click="startFullSelfTest" :disabled="testEngine.status === 'running'">
                    <i class="fa-solid fa-play hw-oneclick-icon"></i>
                    <span class="hw-oneclick-label">一键整机自检</span>
                  </button>
                  <button class="hw-oneclick-btn hw-stop" @click="stopTest" :disabled="testEngine.status !== 'running'">
                    <i class="fa-solid fa-stop hw-oneclick-icon"></i>
                    <span class="hw-oneclick-label">停止自检</span>
                  </button>
                </div>

                <!-- 右侧 RS485 -->
                <div class="hw-side-right">
                  <div class="hw-port hw-rs485">
                    <span class="hw-port-led"></span>
                    <span class="hw-port-name">485-2</span>
                  </div>
                  <div class="hw-485-label-v">485端口</div>
                  <div class="hw-port hw-rs485">
                    <span class="hw-port-led"></span>
                    <span class="hw-port-name">485-1</span>
                  </div>
                </div>
              </div>

              <!-- 底部 继电器输出 -->
              <div class="hw-relay-row">
                <div class="hw-relay-label">继电器</div>
                <div class="hw-relay-items">
                  <div v-for="i in 22" :key="'r'+i" class="hw-port hw-relay">
                    <span class="hw-port-name">R{{ i }}</span>
                    <span class="hw-port-led"></span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <fieldset class="win-group">
            <legend>下位机参数初始化</legend>
            <div class="config-row">
              <button class="win-btn-primary" @click="handleConfigPush">
                <i class="fa-solid fa-download"></i>
                <span>下发默认配置到内存</span>
              </button>
            </div>
          </fieldset>
        </div>
      </template>

      <!-- 视图三：手动调试点检 -->
      <template v-if="currentView === 'manual'">
        <div class="manual-panel">
          <div class="warning-bar">
            <i class="fa-solid fa-triangle-exclamation"></i>
            手动调试接管状态警告：此操作将强行锁定下位机外设，自动算法将被挂起。
          </div>

          <fieldset class="win-group">
            <legend>继电器 (DO) 手动强制点检 — 22 路</legend>
            <div class="relay-grid">
              <div v-for="i in 22" :key="i" class="relay-item">
                <el-switch v-model="manualRelays[i-1]" active-color="#13ce66"></el-switch>
                <span>R{{ i }}</span>
              </div>
            </div>
          </fieldset>
        </div>
      </template>

    </div>

    <!-- 底部状态栏 (Status Bar) -->
    <div class="win-status-bar">
      <div class="status-cell status-ip">
        测试终端: <span class="ip-text">{{ deviceIp }}</span>
      </div>
      <div class="status-cell status-state">
        状态:
        <span :class="testEngine.status === 'running' ? 'state-running' : 'state-ready'">
          {{ testEngine.status === 'running' ? '● 正在运行' : '■ 系统就绪' }}
        </span>
      </div>
      <div class="status-cell status-cmd">
        {{ currentCmd }}
      </div>
      <div class="status-cell status-pass">
        通过率: <span class="pass-rate">{{ testStats.passRate }}%</span>
        ({{ testStats.passCount }}/{{ testStats.totalCount }})
      </div>
      <div class="status-cell status-progress">
        总进度:
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" :style="{ width: testEngine.progress + '%' }"></div>
        </div>
        <span class="progress-text">{{ testEngine.progress }}%</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useDeviceStore } from '../stores/deviceStore'

const deviceStore = useDeviceStore()

// ==================== 视图状态 ====================
const currentView = ref('test')
const treeRef = ref(null)
const activeLogTab = ref('device')
const isResizing = ref(false)
const registerPanelHeight = ref(45)

// ==================== 配置状态 ====================
const currentCmd = ref('就绪')
const lastError = ref('')
const deviceIp = ref('192.168.1.200')
const comPorts = ref({
  rs485: 'COM3', baudRateRS485: 115200,
  log: 'COM3', baudRateLog: 115200
})
const manualRelays = ref(Array(22).fill(false))

// ==================== 串口日志相关 ====================
const enableRealtimeLogs = ref(true)
let serialPortObj = null
let serialReader = null
let mockInterval = null

// ==================== 左侧项目树数据 ====================
// 从后端 TestCatalog 加载，不再硬编码
const testTree = ref([])

/**
 * 从后端加载测试目录树
 */
const loadTestTree = async () => {
  try {
    const res = await fetch('/api/test/catalog')
    const data = await res.json()
    if (data.success && data.tree) {
      // 为每个节点添加 status 字段
      testTree.value = data.tree.map(group => ({
        ...group,
        children: (group.children || []).map(item => ({
          ...item,
          status: 'not_run'
        }))
      }))
    }
  } catch (err) {
    console.error('[AteTest] Failed to load test catalog:', err)
    // 降级：使用与后端 TestCatalog 一致的目录
    testTree.value = [
      {
        id: 'basic',
        label: '基础硬件自检',
        children: [
          { id: 1, label: 'SPI Flash 自检', status: 'not_run' },
          { id: 2, label: 'EEPROM 自检', status: 'not_run' },
          { id: 3, label: 'RTC 时钟自检', status: 'not_run' },
          { id: 4, label: 'RS485-1 通信自检', status: 'not_run' },
          { id: 5, label: 'RS485-2 通信自检', status: 'not_run' },
          { id: 6, label: 'CAN/扩展板自检', status: 'not_run' },
          { id: 7, label: 'ADC/AO 自检', status: 'not_run' },
          { id: 8, label: '22 路继电器自检', status: 'not_run' },
          { id: 9, label: 'RS485 热切换自检', status: 'not_run' },
        ]
      },
      {
        id: 'business',
        label: '业务逻辑测试',
        children: [
          { id: 101, label: '自动通风测试', status: 'not_run' },
          { id: 102, label: '开口控制测试', status: 'not_run' },
          { id: 103, label: '水帘控制测试', status: 'not_run' },
          { id: 104, label: '喷淋控制测试', status: 'not_run' },
          { id: 105, label: '加热控制测试', status: 'not_run' },
        ]
      }
    ]
  }
}

/**
 * 传感器测试场景降级目录（与后端 TestScenarioCatalog 一致）
 * 后端未启动时使用此硬编码列表
 */
const SENSOR_SCENARIOS_FALLBACK = [
  // 前置检查
  { id: 'PRE-FIELD-001', testId: 'PRE-FIELD-001', name: '场区类型读取与地址表加载', group: '前置检查', priority: 'P0', isP1Required: false, estimatedSeconds: 5, dependencies: [] },
  { id: 'PRE-INSTALL-001', testId: 'PRE-INSTALL-001', name: '传感器安装状态读取', group: '前置检查', priority: 'P0', isP1Required: false, estimatedSeconds: 5, dependencies: [] },
  { id: 'PRE-ENV-001', testId: 'PRE-ENV-001', name: '环控器传感器数据块读取', group: '前置检查', priority: 'P0', isP1Required: false, estimatedSeconds: 5, dependencies: [] },
  // 正常抄读
  { id: 'T-READ-001', testId: 'T-READ-001', name: '室内温度传感器抄读', group: '正常抄读', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  { id: 'T-READ-002', testId: 'T-READ-002', name: '室内湿度传感器抄读', group: '正常抄读', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  { id: 'T-READ-003', testId: 'T-READ-003', name: '压差传感器抄读', group: '正常抄读', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  { id: 'T-READ-004', testId: 'T-READ-004', name: 'CO2 传感器抄读', group: '正常抄读', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  // 异常过滤
  { id: 'T-ABNF-001', testId: 'T-ABNF-001', name: '通信失败 ErRead 过滤', group: '异常过滤', priority: 'P0', isP1Required: true, estimatedSeconds: 60, dependencies: [] },
  { id: 'T-ABNF-002', testId: 'T-ABNF-002', name: '数值不变 ErMax 过滤', group: '异常过滤', priority: 'P1', isP1Required: true, estimatedSeconds: 300, dependencies: [] },
  { id: 'T-ABNF-003-A', testId: 'T-ABNF-003-A', name: '奇数路温度偏差剔除', group: '异常过滤', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  { id: 'T-ABNF-003-B', testId: 'T-ABNF-003-B', name: '偶数路温度偏差剔除', group: '异常过滤', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  // 历史回退
  { id: 'T-HIST-001-A', testId: 'T-HIST-001-A', name: '三组历史数据冻结', group: '历史回退', priority: 'P0', isP1Required: true, estimatedSeconds: 600, dependencies: [] },
  { id: 'T-HIST-001-B', testId: 'T-HIST-001-B', name: '启动历史回退验证', group: '历史回退', priority: 'P0', isP1Required: true, estimatedSeconds: 600, dependencies: ['T-HIST-001-A'] },
  { id: 'T-HIST-003', testId: 'T-HIST-003', name: '历史数据更新与对时跳变防污染', group: '历史回退', priority: 'P0', isP1Required: true, estimatedSeconds: 300, dependencies: [] },
  // 配置热更新
  { id: 'T-HOT-001', testId: 'T-HOT-001', name: '传感器启用热更新', group: '配置热更新', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  { id: 'T-HOT-002', testId: 'T-HOT-002', name: '传感器禁用热更新', group: '配置热更新', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  { id: 'T-HOT-003', testId: 'T-HOT-003', name: 'RS485 端口切换热更新', group: '配置热更新', priority: 'P1', isP1Required: true, estimatedSeconds: 60, dependencies: [] },
  { id: 'T-HOT-004', testId: 'T-HOT-004', name: '温度告警阈值热更新', group: '配置热更新', priority: 'P1', isP1Required: true, estimatedSeconds: 60, dependencies: [] },
  { id: 'T-HOT-005', testId: 'T-HOT-005', name: '湿度告警阈值热更新', group: '配置热更新', priority: 'P1', isP1Required: true, estimatedSeconds: 60, dependencies: [] },
  { id: 'T-HOT-006', testId: 'T-HOT-006', name: '温度补偿值热更新', group: '配置热更新', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  { id: 'T-HOT-007', testId: 'T-HOT-007', name: '湿度补偿值热更新', group: '配置热更新', priority: 'P0', isP1Required: true, estimatedSeconds: 30, dependencies: [] },
  // 综合场景
  { id: 'T-COMP-001', testId: 'T-COMP-001', name: '传感器离线后恢复', group: '综合场景', priority: 'P0', isP1Required: true, estimatedSeconds: 60, dependencies: [] },
  { id: 'T-COMP-002', testId: 'T-COMP-002', name: '多路传感器同时失效', group: '综合场景', priority: 'P1', isP1Required: true, estimatedSeconds: 60, dependencies: [] },
]

/**
 * 从后端加载传感器测试场景，合并到项目树
 */
const loadSensorScenarios = async () => {
  let scenarios = null
  try {
    const res = await fetch('/api/sensor-test/scenarios')
    const data = await res.json()
    if (data.success && data.scenarios) {
      scenarios = data.scenarios
    }
  } catch (err) {
    console.error('[AteTest] Failed to load sensor scenarios from API:', err)
  }

  // 降级：后端未启动或返回失败时使用硬编码目录
  if (!scenarios) {
    scenarios = SENSOR_SCENARIOS_FALLBACK
    addLog(`[传感器] 后端未连接，使用降级目录 (${scenarios.length} 项)`, 'warn', 'system')
  }

  const groupOrder = ['前置检查', '正常抄读', '异常过滤', '历史回退', '配置热更新', '综合场景']
  const groupMap = {}
  for (const s of scenarios) {
    const g = s.group || s.category || '其他'
    if (!groupMap[g]) groupMap[g] = []
    groupMap[g].push({
      id: `sensor:${s.testId || s.id}`,
      label: `${s.testId || s.id} ${s.name}`,
      status: 'not_run',
      _sensorScenario: s,
    })
  }
  const sensorChildren = []
  for (const g of groupOrder) {
    if (groupMap[g]) sensorChildren.push(...groupMap[g])
  }
  const sensorGroup = {
    id: 'sensor_tests',
    label: '传感器相关检定',
    children: sensorChildren,
  }
  const existIdx = testTree.value.findIndex(g => g.id === 'sensor_tests')
  if (existIdx >= 0) {
    testTree.value[existIdx] = sensorGroup
  } else {
    testTree.value.push(sensorGroup)
  }
  addLog(`[传感器] 已加载 ${sensorChildren.length} 个传感器检定项`, 'info', 'system')
}

const defaultProps = { children: 'children', label: 'label' }

// ==================== 寄存器断言回显表格 ====================
const activeDetailRegisters = ref([
  { id: 1, name: '自检整体状态', result: '等待测试' },
  { id: 2, name: '单项自检结果', result: '等待测试' },
  { id: 3, name: '外设继电器掩码', result: '等待测试' },
  { id: 4, name: '内部环境变量', result: '等待测试' }
])

// ==================== 测试引擎状态 ====================
const testEngine = ref({
  sn: 'SN20260529-001',
  workOrder: 'WO-8000',
  status: 'idle',
  progress: 0,
  currentItemName: '',
  failedItems: []
})

// ==================== 统计逻辑 ====================
const testStats = computed(() => {
  let total = 0, passed = 0
  testTree.value.forEach(group => {
    group.children.forEach(item => {
      if (item.status !== 'not_run') total++
      if (item.status === 'pass') passed++
    })
  })
  return {
    totalCount: total,
    passCount: passed,
    passRate: total > 0 ? Math.round((passed / total) * 100) : 0
  }
})

// ==================== 终端日志 ====================
const systemLogs = ref([])
const deviceLogs = ref([])
const systemTerminal = ref(null)
const deviceTerminal = ref(null)

const addLog = (text, type = 'info', target = 'system') => {
  let logColorType = type
  let cleanText = text

  if (typeof text === 'string') {
    // 1. 如果是来自 MCU 且包含特定 ANSI 颜色转义，则动态调整前景色类型
    if (text.includes('[31m') || text.includes('\u001b[31m') || text.includes('\x1b[31m')) {
      logColorType = 'mcu_red'
    } else if (text.includes('[32m') || text.includes('\u001b[32m') || text.includes('\x1b[32m')) {
      logColorType = 'mcu_green'
    } else if (text.includes('[33m') || text.includes('\u001b[33m') || text.includes('\x1b[33m')) {
      logColorType = 'mcu_yellow'
    } else if (text.includes('[35m') || text.includes('\u001b[35m') || text.includes('\x1b[35m')) {
      logColorType = 'mcu_purple'
    } else if (text.includes('[36m') || text.includes('\u001b[36m') || text.includes('\x1b[36m')) {
      logColorType = 'mcu_cyan'
    }

    // 2. 备用智能前缀规则：若未匹配到 ANSI 转义，根据 RT-Thread / 环控器经典调试等级前缀分类染色
    if (logColorType === type) {
      if (text.includes('[E/') || text.includes('[E ]') || text.includes('[ERROR]')) {
        logColorType = 'mcu_red'
      } else if (text.includes('[W/') || text.includes('[W ]') || text.includes('[WARN]')) {
        logColorType = 'mcu_yellow'
      } else if (text.includes('[I/') || text.includes('[I ]') || text.includes('[INFO]')) {
        logColorType = 'mcu_green'
      } else if (text.includes('[D/') || text.includes('[D ]') || text.includes('[DEBUG]')) {
        logColorType = 'mcu_cyan'
      }
    }

    // 2. 清洗掉所有的 ANSI 颜色控制字符（包含未闭合或不规范写法）
    cleanText = text
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\[[0-9;]*m/g, '')
  }

  const colors = {
    info: 'text-white',
    success: 'text-green-400 font-bold',
    warn: 'text-yellow-400 font-bold',
    error: 'text-red-400 font-bold',
    mcu_green: 'text-green-400',
    mcu_red: 'text-red-400 font-bold',
    mcu_yellow: 'text-yellow-400',
    mcu_cyan: 'text-cyan-400',
    mcu_purple: 'text-purple-400'
  }
  const hexColors = {
    info: '#ffffff',
    success: '#4ade80',
    warn: '#facc15',
    error: '#f87171',
    mcu_green: '#4ade80',
    mcu_red: '#f87171',
    mcu_yellow: '#facc15',
    mcu_cyan: '#22d3ee',
    mcu_purple: '#c084fc'
  }
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0')

  if (target === 'system') {
    if (systemLogs.value.length > 500) systemLogs.value.shift()
    systemLogs.value.push({ time: timeStr, text: cleanText, color: colors[logColorType], styleColor: hexColors[logColorType] || '#ffffff', rawText: cleanText })
    nextTick(() => {
      if (systemTerminal.value) systemTerminal.value.scrollTop = systemTerminal.value.scrollHeight
    })
  } else {
    if (deviceLogs.value.length > 1000) deviceLogs.value.shift()
    deviceLogs.value.push({ time: timeStr, text: cleanText, color: colors[logColorType], styleColor: hexColors[logColorType] || '#ffffff', rawText: cleanText })
    nextTick(() => {
      if (deviceTerminal.value) deviceTerminal.value.scrollTop = deviceTerminal.value.scrollHeight
    })
  }
}

// ==================== 拖拽调整大小 ====================
const startResize = (e) => {
  e.preventDefault()
  isResizing.value = true
  document.body.style.cursor = 'ns-resize'
  document.body.style.userSelect = 'none'

  const startY = e.clientY
  const rightPanel = document.querySelector('.right-panel')
  const totalHeight = rightPanel.clientHeight
  const startHeightPx = (totalHeight * registerPanelHeight.value) / 100

  const doResize = (moveEvent) => {
    if (!isResizing.value) return
    const deltaY = moveEvent.clientY - startY
    const newHeightPx = startHeightPx + deltaY
    let newPercent = (newHeightPx / totalHeight) * 100
    if (newPercent < 15) newPercent = 15
    if (newPercent > 85) newPercent = 85
    registerPanelHeight.value = newPercent
  }

  const stopResize = () => {
    isResizing.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', doResize)
    window.removeEventListener('mouseup', stopResize)
  }

  window.addEventListener('mousemove', doResize)
  window.addEventListener('mouseup', stopResize)
}

// ==================== 日志自动保存控制 ====================
const autoSaveLogs = ref(true)

watch([autoSaveLogs, () => deviceStore.wsConnected], () => {
  if (deviceStore.wsConnected) {
    deviceStore.sendWsMessage({
      type: 'set_log_save_config',
      autoSave: autoSaveLogs.value
    })
  }
}, { immediate: true })

const clearLogs = () => {
  if (activeLogTab.value === 'system') systemLogs.value = []
  else deviceLogs.value = []
}

// ==================== Web Serial API ====================
const toggleSerialConnection = async () => {
  if (enableRealtimeLogs.value) {
    enableRealtimeLogs.value = false
    try {
      if (serialReader) {
        await serialReader.cancel()
        serialReader = null
      }
      if (serialPortObj) {
        await serialPortObj.close()
        serialPortObj = null
      }
      addLog("<<< 串口物理连接已断开，报文接收停止。", "warn", "device")
    } catch (err) {
      addLog(`关闭串口时发生错误: ${err}`, "error", "device")
    }
  } else {
    if (!('serial' in navigator)) {
      addLog("【系统环境错误】此浏览器不支持获取物理串口，无法启用真实报文。", "error", "device")
      enableRealtimeLogs.value = true
      activeLogTab.value = 'device'
      startMockSerial()
      return
    }

    try {
      serialPortObj = await navigator.serial.requestPort()
      await serialPortObj.open({ baudRate: comPorts.value.baudRateLog })
      enableRealtimeLogs.value = true
      activeLogTab.value = 'device'
      addLog(`>>> 成功打开物理串口，波特率 ${comPorts.value.baudRateLog}，正在读取硬件报文...`, "success", "device")

      const textDecoder = new window.TextDecoderStream()
      const readableStreamClosed = serialPortObj.readable.pipeTo(textDecoder.writable)
      serialReader = textDecoder.readable.getReader()
      readSerialLoop()
    } catch (err) {
      addLog(`串口连接被拒绝或打开失败: ${err.message} (降级到演示模式)`, "warn", "device")
      enableRealtimeLogs.value = true
      activeLogTab.value = 'device'
      startMockSerial()
    }
  }
}

const startMockSerial = () => {
  if (mockInterval) clearInterval(mockInterval)
  addLog(`>>> [模拟串口模式] 正在模拟从虚拟 COM 口接收报文...`, "success", "device")
  mockInterval = setInterval(() => {
    if (!enableRealtimeLogs.value) {
      clearInterval(mockInterval)
      return
    }
    if (testEngine.value.status !== 'running') {
      const randomHex = Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()
      addLog(`[RX] 01 03 20 ${randomHex} A4 5F ... (终端心跳保持)`, "info", "device")
    }
  }, 2000)
}

let serialBuffer = ''
const readSerialLoop = async () => {
  try {
    while (true) {
      const { value, done } = await serialReader.read()
      if (done) break
      if (value) {
        serialBuffer += value
        let lines = serialBuffer.split('\n')
        serialBuffer = lines.pop()
        lines.forEach(line => {
          if (line.trim().length > 0) {
            addLog(`[RX] ${line.trim()}`, "info", "device")
          }
        })
      }
    }
  } catch (error) {
    addLog(`硬件读取发生错误，可能是数据线松动: ${error}`, "error", "device")
    enableRealtimeLogs.value = false
  } finally {
    if (serialReader) serialReader.releaseLock()
  }
}

// ==================== 日志导出 ====================
const exportLogs = () => {
  const currentLogs = activeLogTab.value === 'system' ? systemLogs.value : deviceLogs.value
  const logName = activeLogTab.value === 'system' ? 'System_Log' : 'Device_COM_Log'

  if (currentLogs.length === 0) {
    alert('当前终端没有可以导出的运行日志。')
    return
  }
  const logContent = currentLogs.map(l => `[${l.time}] ${l.rawText}`).join('\n')
  const blob = new Blob([logContent], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `ATE_${logName}_${new Date().getTime()}.txt`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  alert(`【${logName}】日志已成功保存到本地电脑！`)
}

// ==================== 样式辅助函数 ====================
const getStatusText = (status) => {
  return { 'pass': '合格', 'fail': '不合格', 'running': '测试中...', 'not_run': '' }[status] || ''
}

const getStatusColor = (status) => {
  return { 'pass': 'text-green-600', 'fail': 'text-red-600', 'running': 'text-blue-600' }[status] || ''
}

const tableRowClassName = ({ row, rowIndex }) => {
  if (row.result === '合格') return 'win-row-pass'
  if (row.result === '不合格') return 'win-row-fail'
  return rowIndex % 2 === 1 ? 'bg-gray-50' : ''
}

// ==================== 核心执行引擎 ====================
let activeQueue = []
let executionIndex = 0

const buildQueue = (onlyFailed = false) => {
  if (!treeRef.value) return []
  const checkedNodes = treeRef.value.getCheckedNodes(true)
  if (onlyFailed) return checkedNodes.filter(n => n.status === 'fail')
  return checkedNodes
}

const updateRegisterAssertMock = (item) => {
  if (item.id <= 9) {
    activeDetailRegisters.value = [
      { id: 1, name: '自检整体状态', result: '正在测试' },
      { id: 2, name: '单项自检结果', result: '正在测试' },
      { id: 3, name: '单项自检错误码', result: '正在测试' }
    ]
    addLog(`[TCP TX -> 502] 00 01 00 00 00 06 01 03 80 00 00 28 (读取自检状态及会话ID)`, 'info', 'system')
    if (enableRealtimeLogs.value) addLog(`[TX] 01 03 80 00 00 28 C4 13`, 'info', 'device')
  } else if (item.id > 9 && item.id <= 35) {
    activeDetailRegisters.value = [
      { id: 1, name: '室内实际平均温度', result: '正在测试' },
      { id: 2, name: '当前自动通风等级', result: '正在测试' },
      { id: 3, name: '风机继电器输出掩码', result: '正在测试' }
    ]
    addLog(`[TCP JSON 9001] {"functionId":"properties.get","itemName":"Fanlogic"}`, 'info', 'system')
    if (enableRealtimeLogs.value) addLog(`[RX] {"event":"reply","data":{"Fanlogic":3}}`, 'info', 'device')
  } else {
    activeDetailRegisters.value = [
      { id: 1, name: '传感器历史故障字', result: '正在测试' },
      { id: 2, name: '系统安全运行模式', result: '正在测试' }
    ]
    addLog(`[TCP TX] 00 01 00 00 00 06 01 03 10 30 00 01 (监控高可用备用切换机制)`, 'info', 'system')
    if (enableRealtimeLogs.value) addLog(`[TX] 01 03 10 30 00 01 80 CA`, 'info', 'device')
  }
}

const startSingleTest = () => {
  activeQueue = buildQueue()
  if (activeQueue.length === 0) {
    alert('请先勾选待检定项目')
    return
  }
  if (executionIndex >= activeQueue.length) executionIndex = 0
  testEngine.value.status = 'running'
  currentCmd.value = `单步执行: ${activeQueue[executionIndex].label}`

  executeStep(activeQueue[executionIndex], () => {
    testEngine.value.status = 'idle'
    currentCmd.value = '单步执行完毕，系统就绪。'
    executionIndex++
  })
}

const startContinuousTest = () => {
  activeQueue = buildQueue()
  if (activeQueue.length === 0) return alert('请先勾选待检定项目')

  testEngine.value.status = 'running'
  testEngine.value.failedItems = []
  executionIndex = 0
  lastError.value = ''
  addLog(`=== 开始连续检定批次, 共 ${activeQueue.length} 项 ===`, 'info', 'system')

  const runNext = () => {
    if (executionIndex >= activeQueue.length) {
      testEngine.value.status = testEngine.value.failedItems.length > 0 ? 'fail' : 'pass'
      testEngine.value.progress = 100
      currentCmd.value = '连续检定完成。'
      addLog(`=== 批次检定结束。失败 ${testEngine.value.failedItems.length} 项 ===`, testEngine.value.status === 'pass' ? 'success' : 'error', 'system')
      return
    }
    currentCmd.value = `正在检定 (${executionIndex + 1}/${activeQueue.length}): ${activeQueue[executionIndex].label}`
    executeStep(activeQueue[executionIndex], () => {
      executionIndex++
      testEngine.value.progress = Math.round((executionIndex / activeQueue.length) * 100)
      runNext()
    })
  }
  runNext()
}

const startFullSelfTest = () => {
  if (testEngine.value.status === 'running') return
  if (!treeRef.value) return

  // 全选所有节点
  const allKeys = []
  testTree.value.forEach(g => {
    allKeys.push(g.id)
    g.children.forEach(c => allKeys.push(c.id))
  })
  treeRef.value.setCheckedKeys(allKeys)

  // 重置所有状态
  testTree.value.forEach(g => g.children.forEach(c => c.status = 'not_run'))
  testEngine.value.progress = 0
  testEngine.value.failedItems = []
  lastError.value = ''
  activeLogTab.value = 'system'
  systemLogs.value = []

  addLog('=== 一键整机自检启动，全选所有检定项 ===', 'success', 'system')
  startContinuousTest()
}

const startFailedOnlyTest = () => {
  activeQueue = buildQueue(true)
  if (activeQueue.length === 0) return alert('当前无不合格项')
  testEngine.value.status = 'running'
  executionIndex = 0
  addLog(`=== 复测不合格项, 共 ${activeQueue.length} 项 ===`, 'warn', 'system')

  const runNext = () => {
    if (executionIndex >= activeQueue.length) {
      testEngine.value.status = 'idle'
      currentCmd.value = '复测结束。'
      return
    }
    executeStep(activeQueue[executionIndex], () => {
      executionIndex++
      runNext()
    })
  }
  runNext()
}

// ==================== 传感器测试执行 ====================

const currentSensorTaskId = ref(null)

const executeSensorStep = async (node, callback) => {
  const scenario = node._sensorScenario
  if (!scenario) {
    node.status = 'fail'
    addLog(`[FAIL] 传感器场景数据缺失: ${node.label}`, 'error', 'system')
    callback()
    return
  }

  const scenarioId = scenario.testId || scenario.id
  addLog(`[传感器] 开始执行: ${scenarioId} ${scenario.name}`, 'info', 'system')
  activeDetailRegisters.value = [
    { id: 1, name: '测试项', result: scenario.name },
    { id: 2, name: '场景 ID', result: scenarioId },
    { id: 3, name: '优先级', result: scenario.priority || '-' },
    { id: 4, name: '状态', result: '执行中...' },
  ]

  try {
    const resp = await fetch('/api/sensor-test/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenarioIds: [scenarioId],
        deviceKey: `${deviceIp.value}:502:1`,
        fieldType: 'A',
      }),
    })
    const data = await resp.json()
    if (data.success) {
      currentSensorTaskId.value = data.taskId
      addLog(`[传感器] 任务已提交: ${data.taskId}`, 'info', 'system')
      await waitForSensorTask(data.taskId, node, callback)
    } else {
      node.status = 'fail'
      addLog(`[FAIL] 传感器任务提交失败: ${data.error}`, 'error', 'system')
      activeDetailRegisters.value = [
        { id: 1, name: '错误', result: data.error || '提交失败' },
      ]
      callback()
    }
  } catch (err) {
    node.status = 'fail'
    addLog(`[FAIL] 传感器执行异常: ${err.message}`, 'error', 'system')
    activeDetailRegisters.value = [
      { id: 1, name: '错误', result: err.message },
    ]
    callback()
  } finally {
    currentSensorTaskId.value = null
  }
}

const waitForSensorTask = async (taskId, node, callback) => {
  const maxWait = 600000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const resp = await fetch(`/api/sensor-test/tasks/${taskId}`)
      const data = await resp.json()
      if (data.success && data.task) {
        const task = data.task
        if (task.assertions && task.assertions.length) {
          activeDetailRegisters.value = task.assertions.map((a, i) => ({
            id: i + 1,
            name: a.message || a.type || '-',
            result: a.pass ? '合格' : '不合格',
          }))
        }
        if (task.status === 'pass' || task.status === 'fail' ||
            task.status === 'error' || task.status === 'stopped') {
          if (task.status === 'pass') {
            node.status = 'pass'
            addLog(`[PASS] ${node.label} 测试通过`, 'success', 'system')
          } else {
            node.status = 'fail'
            testEngine.value.failedItems.push(node)
            addLog(`[FAIL] ${node.label} 测试失败 (${task.status})`, 'error', 'system')
          }
          callback()
          return
        }
      }
    } catch (_) {}
  }

  node.status = 'fail'
  testEngine.value.failedItems.push(node)
  addLog(`[FAIL] ${node.label} 测试超时`, 'error', 'system')
  callback()
}

const stopTest = () => {
  // 停止传感器测试任务
  if (currentSensorTaskId.value) {
    fetch('/api/sensor-test/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: currentSensorTaskId.value }),
    }).catch(() => {})
    addLog('已发送停止传感器测试指令。', 'warn', 'system')
  }
  if (deviceStore.wsConnected && deviceStore.ateSession) {
    deviceStore.stopTest()
    addLog('已发送停止检定指令到后端。', 'warn', 'system')
  } else if (!currentSensorTaskId.value) {
    testEngine.value.status = 'idle'
    currentCmd.value = '操作员已强行中止检定。'
    addLog('检定序列被人工中止。', 'warn', 'system')
  }
}

const resetTest = () => {
  if (deviceStore.wsConnected && deviceStore.ateSession) {
    deviceStore.resetTest()
    addLog('已发送复位指令到后端。', 'warn', 'system')
  } else {
    testEngine.value.status = 'idle'
    testEngine.value.progress = 0
    lastError.value = ''
    testTree.value.forEach(g => g.children?.forEach(c => c.status = 'not_run'))
    clearLogs()
    currentCmd.value = '状态已重置'
  }
}

const executeStep = (node, callback) => {
  testEngine.value.currentItemName = node.label
  node.status = 'running'

  // 传感器测试项：走 /api/sensor-test/run
  if (typeof node.id === 'string' && node.id.startsWith('sensor:')) {
    executeSensorStep(node, callback)
    return
  }

  addLog(`[System] 下发检定指令: 节点 [${node.label}] (ID=${node.id})`, 'info', 'system')

  // 通过后端 WebSocket 发起测试
  if (deviceStore.wsConnected) {
    deviceStore.startTest({
      deviceIp: deviceStore.selectedDeviceIp || deviceIp.value,
      operatorInputId: testEngine.value.sn,
      selectedItemIds: [node.id],
      deviceModel: '9200',
      workOrder: testEngine.value.workOrder,
    })

    // 监听后端响应（轮询 ateStatus 变化）
    const checkStatus = setInterval(() => {
      if (deviceStore.ateStatus === 'pass' || deviceStore.ateStatus === 'fail' || deviceStore.ateStatus === 'error') {
        clearInterval(checkStatus)

        if (deviceStore.ateStatus === 'pass') {
          node.status = 'pass'
          addLog(`[PASS] 节点 [${node.label}] 自检合格`, 'success', 'system')
          activeDetailRegisters.value.forEach(r => r.result = '合格')
        } else {
          node.status = 'fail'
          testEngine.value.failedItems.push(node)
          lastError.value = `${node.id} ${node.label} 测试失败`
          addLog(`[FAIL] 节点 [${node.label}] 自检不合格`, 'error', 'system')
          activeDetailRegisters.value.forEach(r => r.result = '不合格')
        }
        callback()
      }
    }, 200)

    // 超时处理
    setTimeout(() => {
      clearInterval(checkStatus)
      if (node.status === 'running') {
        node.status = 'fail'
        testEngine.value.failedItems.push(node)
        addLog(`[FAIL] 节点 [${node.label}] 测试超时`, 'error', 'system')
        activeDetailRegisters.value.forEach(r => r.result = '不合格')
        callback()
      }
    }, 30000)
  } else {
    // 无后端连接时，提示用户
    node.status = 'fail'
    testEngine.value.failedItems.push(node)
    addLog(`[ERROR] 节点 [${node.label}] 后端未连接，无法执行测试`, 'error', 'system')
    activeDetailRegisters.value.forEach(r => r.result = '未连接')
    callback()
  }
}

const downloadReport = async () => {
  try {
    const res = await fetch('/api/test/reports')
    const data = await res.json()
    if (data.success && data.reports && data.reports.length > 0) {
      const latest = data.reports[0]
      window.open(`/api/test/reports/${latest.fileName}`, '_blank')
      addLog(`已打开报告: ${latest.fileName}`, 'success', 'system')
    } else {
      alert('当前无测试报告可下载')
    }
  } catch (err) {
    alert('下载报告失败: ' + err.message)
  }
}

const handleConfigPush = async () => {
  try {
    const res = await fetch('/api/test/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIp: deviceIp.value,
        comPorts: comPorts.value,
      })
    })
    const data = await res.json()
    if (data.success) {
      addLog('配置下发成功', 'success', 'system')
    } else {
      addLog('配置下发失败: ' + (data.error || '未知错误'), 'error', 'system')
    }
  } catch (err) {
    addLog('配置下发失败: ' + err.message, 'error', 'system')
  }
}

// ==================== 传感器 WebSocket ====================
let sensorWs = null
let sensorWsReconnectTimer = null

const connectSensorWebSocket = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = window.location.port === '5173'
    ? `${protocol}//127.0.0.1:3001`
    : `${protocol}//${window.location.host}`
  try {
    sensorWs = new WebSocket(wsUrl)
    sensorWs.onopen = () => {
      addLog('[传感器] WebSocket 已连接', 'info', 'system')
    }
    sensorWs.onclose = () => {
      sensorWsReconnectTimer = setTimeout(connectSensorWebSocket, 3000)
    }
    sensorWs.onerror = () => {}
    sensorWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleSensorWsMessage(msg)
      } catch (_) {}
    }
  } catch (_) {}
}

const handleSensorWsMessage = (msg) => {
  switch (msg.type) {
    case 'mcu_log':
      // 启用实时日志显示，并将来自后端的串口日志 append 到设备日志中
      enableRealtimeLogs.value = true
      addLog(msg.data, 'info', 'device')
      break
    case 'sensor_test_progress':
      addLog(`[传感器] 进度: ${msg.scenarioId} (${(msg.index || 0) + 1}/${msg.total})`, 'info', 'system')
      break
    case 'sensor_test_scenario_finished': {
      const nodeId = `sensor:${msg.scenarioId}`
      testTree.value.forEach(g => {
        g.children?.forEach(c => {
          if (c.id === nodeId) {
            c.status = msg.status === 'pass' ? 'pass' : msg.status === 'skip' ? 'not_run' : 'fail'
          }
        })
      })
      if (msg.assertions) {
        activeDetailRegisters.value = msg.assertions.map((a, i) => ({
          id: i + 1,
          name: a.message || a.type || '-',
          result: a.pass ? '合格' : '不合格',
        }))
      }
      addLog(`[传感器] ${msg.scenarioId} → ${msg.status}`, msg.status === 'pass' ? 'success' : 'error', 'system')
      break
    }
    case 'sensor_test_finished':
      addLog(`[传感器] 批量测试完成: ${msg.result?.passed || 0}/${msg.result?.total || 0}`, 'success', 'system')
      break
    case 'sensor_test_error':
      addLog(`[传感器] 测试异常: ${msg.error}`, 'error', 'system')
      break
  }
}

// ==================== 生命周期 ====================
onMounted(async () => {
  // 从后端加载测试目录树
  await loadTestTree()

  // 加载传感器测试场景到项目树
  await loadSensorScenarios()

  // 连接传感器 WebSocket
  connectSensorWebSocket()

  // 全选所有节点
  if (treeRef.value && testTree.value.length > 0) {
    const allKeys = []
    testTree.value.forEach(g => {
      allKeys.push(g.id)
      g.children?.forEach(c => allKeys.push(c.id))
    })
    treeRef.value.setCheckedKeys(allKeys)
  }

  // 获取当前测试会话
  deviceStore.getTestSession()
})

onUnmounted(() => {
  if (sensorWs) {
    sensorWs.close()
    sensorWs = null
  }
  if (sensorWsReconnectTimer) {
    clearTimeout(sensorWsReconnectTimer)
  }
})

// ==================== 状态同步 watchers ====================

// 同步后端进度到本地 testEngine
watch(() => deviceStore.ateProgress, (val) => {
  testEngine.value.progress = val || 0
})

// 同步后端状态到本地 testEngine
watch(() => deviceStore.ateStatus, (val) => {
  if (val === 'running' || val === 'starting') {
    testEngine.value.status = 'running'
  } else if (val === 'idle') {
    testEngine.value.status = 'idle'
  } else if (val === 'pass') {
    testEngine.value.status = 'pass'
  } else if (val === 'fail' || val === 'error') {
    testEngine.value.status = 'fail'
  }
})

// 同步后端 timeline 到本地项目树节点状态
watch(() => deviceStore.ateTimeline, (timeline) => {
  if (!timeline || typeof timeline !== 'object') return
  Object.entries(timeline).forEach(([itemId, item]) => {
    const id = parseInt(itemId)
    testTree.value.forEach(g => {
      g.children?.forEach(c => {
        if (c.id === id) {
          if (item.state === 2) c.status = 'pass'       // SINGLE_RESULT.PASS
          else if (item.state === 3) c.status = 'fail'  // SINGLE_RESULT.FAIL
          else if (item.state === 1) c.status = 'running'
          else if (item.state === 5) c.status = 'fail'  // TIMEOUT
        }
      })
    })
  })
}, { deep: true })

// 手动继电器开关 watcher：发送 WebSocket 消息
watch(manualRelays, (newVal) => {
  if (deviceStore.wsConnected) {
    const outputs = {}
    newVal.forEach((val, idx) => {
      outputs[`relay_${idx + 1}`] = val ? 1 : 0
    })
    deviceStore.manualForceIo({
      deviceIp: deviceStore.selectedDeviceIp || deviceIp.value,
      outputs,
      timeoutMs: 0
    })
  }
}, { deep: true })
</script>

<style scoped>
/* ============================================
   WinForms 经典浅灰色调样式
   ============================================ */

/* 全局容器 */
.ate-page-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: #f0f0f0;
  color: #000;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  font-size: 12px;
}

/* 蓝色渐变标题栏 */
.win-title-bar {
  background: linear-gradient(to right, #005c99 0%, #00a2e8 50%, #e0f0ff 100%);
  color: white;
  font-weight: bold;
  text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
  height: 40px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  flex-shrink: 0;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-left i {
  font-size: 20px;
}

.title-left span {
  font-size: 13px;
  letter-spacing: 1px;
  font-family: serif;
}

/* 经典工具栏 */
.win-toolbar {
  height: 64px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-bottom: 1px solid #808080;
  gap: 4px;
  flex-shrink: 0;
  background: #f0f0f0;
  box-shadow: inset 0 1px 0 #fff;
}

/* 工具栏分隔线 */
.toolbar-divider {
  width: 1px;
  height: 40px;
  background: #808080;
  margin: 0 4px;
}

.toolbar-spacer {
  flex: 1;
}

/* 经典工具栏按钮 */
.win-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  padding: 4px 10px;
  font-size: 11px;
  color: #000;
  cursor: pointer;
  min-width: 60px;
}

.win-btn:hover:not(:disabled) {
  background-color: #e5f1fb;
  border: 1px solid #0078d7;
  border-radius: 2px;
}

.win-btn:active:not(:disabled) {
  background-color: #cce4f7;
}

.win-btn:disabled {
  color: #999;
  cursor: not-allowed;
  filter: grayscale(100%);
  opacity: 0.6;
}

.win-btn i {
  font-size: 18px;
  margin-bottom: 4px;
}

.win-btn.active {
  background-color: #cce4f7;
  border: 1px solid #0078d7;
}

/* 一键整机自检按钮 - 拓扑图中央大按钮 */
.hw-oneclick-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 160px;
  height: 80px;
  background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 50%, #a5d6a7 100%);
  border: 2px solid #4caf50;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.25);
}

.hw-oneclick-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #c8e6c9 0%, #a5d6a7 50%, #81c784 100%);
  border-color: #388e3c;
  box-shadow: 0 4px 12px rgba(76, 175, 80, 0.4);
  transform: scale(1.03);
}

.hw-oneclick-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.hw-oneclick-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hw-oneclick-icon {
  font-size: 28px;
  color: #2e7d32;
}

.hw-oneclick-label {
  font-size: 15px;
  font-weight: bold;
  color: #1b5e20;
  letter-spacing: 1px;
}

/* 停止自检按钮 */
.hw-stop {
  background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 50%, #ef9a9a 100%);
  border-color: #ef5350;
  box-shadow: 0 2px 8px rgba(239, 83, 80, 0.25);
}

.hw-stop:hover:not(:disabled) {
  background: linear-gradient(135deg, #ffcdd2 0%, #ef9a9a 50%, #e57373 100%);
  border-color: #c62828;
  box-shadow: 0 4px 12px rgba(239, 83, 80, 0.4);
}

.hw-stop .hw-oneclick-icon {
  color: #c62828;
}

.hw-stop .hw-oneclick-label {
  color: #b71c1c;
}

/* 启用报文按钮 */
.enable-log-btn {
  display: flex;
  align-items: center;
  cursor: pointer;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: 2px;
}

.enable-log-btn:hover {
  background-color: #e5f1fb;
  border-color: #0078d7;
}

.enable-log-btn .checkbox {
  width: 16px;
  height: 16px;
  margin-left: 4px;
  margin-right: 4px;
  pointer-events: none;
}

/* 主体内容区 */
.ate-main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  padding: 4px;
  gap: 4px;
  background: #d4d0c8;
}


/* 经典面板边框下沉效果 */
.win-panel-inset {
  border-top: 1px solid #808080;
  border-left: 1px solid #808080;
  border-bottom: 1px solid #ffffff;
  border-right: 1px solid #ffffff;
  background: #ffffff;
}

/* 左侧项目树面板 */
.tree-panel {
  width: 280px;
  display: flex;
  flex-direction: column;
  background: white;
  border: 1px solid #808080;
  flex-shrink: 0;
}

.panel-header {
  background: linear-gradient(to bottom, #ffffff 0%, #e3edf7 100%);
  border-bottom: 1px solid #808080;
  padding: 4px 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-title {
  font-weight: bold;
  color: #003399;
}

.tree-container {
  flex: 1;
  overflow: auto;
  padding: 4px;
}

.tree-node-content {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding-right: 8px;
}

.status-badge {
  font-weight: bold;
  margin-left: 8px;
}

/* 右侧面板 */
.right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
}

/* 寄存器监控面板 */
.register-panel {
  height: 50%;
  display: flex;
  flex-direction: column;
  background: white;
  border: 1px solid #808080;
  position: relative;
}

.current-item {
  color: #003399;
  font-size: 11px;
  font-weight: bold;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.register-table-container {
  flex: 1;
  overflow: auto;
  background: white;
}

/* 终端面板 */
.terminal-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: white;
  border: 1px solid #808080;
}

.terminal-tabs {
  display: flex;
  align-items: flex-end;
  background: #f0f0f0;
  border-bottom: 1px solid #808080;
  padding: 4px 4px 0 4px;
  gap: 4px;
}

.terminal-tab {
  padding: 4px 16px;
  border: 1px solid #808080;
  border-bottom: none;
  background: #e3edf7;
  cursor: pointer;
  font-size: 12px;
  border-radius: 2px 2px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.terminal-tab:hover:not(.active) {
  background: #cce4f7;
}

.terminal-tab.active {
  background: white;
  border-bottom: 1px solid white;
  font-weight: bold;
  color: #003399;
  z-index: 10;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  animation: pulse 2s infinite;
  box-shadow: 0 0 4px #22c55e;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.tab-spacer {
  flex: 1;
}

.tab-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  background: #f0f0f0;
}

.tool-link {
  color: #0066cc;
  font-size: 11px;
  text-decoration: none;
}

.tool-link:hover {
  text-decoration: underline;
}

.tool-divider {
  color: #808080;
}

.terminal-content {
  flex: 1;
  height: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.4;
  position: relative;
}

.terminal-system {
  background: black;
  color: white;
}

.terminal-device {
  background: #121212;
  color: white;
}

.terminal-body {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  overflow-y: scroll;
  padding: 8px;
  box-sizing: border-box;
}

.log-time {
  color: #808080;
  margin-right: 8px;
}

/* 系统配置面板 */
.config-panel {
  flex: 1;
  background: white;
  border: 1px solid #808080;
  padding: 16px;
  overflow: auto;
}

.win-group {
  border: 1px solid #d0d0bf;
  border-radius: 3px;
  padding: 10px;
  margin-bottom: 15px;
  background-color: #fafafa;
  max-width: 600px;
}

.win-group legend {
  color: #003399;
  padding: 0 5px;
  font-weight: bold;
  font-size: 12px;
}

.config-row {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
}

.config-label {
  width: 128px;
  text-align: right;
  padding-right: 16px;
  font-weight: bold;
  color: #374151;
}

.rs485-label {
  font-size: 12px;
  letter-spacing: 0;
  font-weight: bold;
  color: #374151;
}

.config-input {
  width: 192px;
}

.config-select {
  width: 160px;
  margin-right: 8px;
}

.config-select-sm {
  width: 128px;
}

.win-btn-primary {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #e5f1fb;
  border: 1px solid #0078d7;
  padding: 8px 16px;
  font-size: 12px;
  cursor: pointer;
}

.win-btn-primary:hover {
  background: #cce4f7;
}

/* 硬件端口拓扑示意图 */
.hw-topo-container {
  margin-bottom: 20px;
}

.hw-topo-board {
  background: #f0f4f8;
  border: 1px solid #b0bec5;
  border-radius: 10px;
  padding: 24px;
  max-width: 1050px;
}

/* DI 输入行 */
.hw-di-row {
  text-align: center;
  margin-bottom: 12px;
}

.hw-di-label,
.hw-relay-label {
  display: inline-block;
  background: #607d8b;
  color: white;
  font-size: 14px;
  padding: 4px 24px;
  border-radius: 4px;
  margin-bottom: 8px;
  font-weight: bold;
}

.hw-di-items,
.hw-relay-items {
  display: flex;
  justify-content: center;
  flex-wrap: nowrap;
  gap: 5px;
}

/* 端口单元 */
.hw-port {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 30px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: bold;
  gap: 2px;
  position: relative;
}

.hw-di {
  background: #5c9ce6;
  color: white;
  padding: 4px 0;
}

.hw-relay {
  background: #5c9ce6;
  color: white;
  padding: 4px 0;
}

.hw-io {
  background: #5c9ce6;
  color: white;
  width: 90px;
  height: 28px;
  flex-direction: row;
  gap: 6px;
  padding: 0 8px;
}

.hw-rs485 {
  background: #5c9ce6;
  color: white;
  width: 100px;
  height: 36px;
  flex-direction: row;
  gap: 8px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 13px;
}

/* LED 指示灯 */
.hw-port-led {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid rgba(0,0,0,0.15);
  flex-shrink: 0;
}

.hw-port-name {
  white-space: nowrap;
  line-height: 1;
}

/* 中部三栏 */
.hw-middle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 130px;
  margin: 8px 0;
}

/* 左侧 AI/AO */
.hw-side-left {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hw-side-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hw-port-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hw-side-label {
  font-size: 14px;
  color: #607d8b;
  font-weight: bold;
}

.hw-side-label-v {
  writing-mode: vertical-rl;
  text-orientation: upright;
  background: #607d8b;
  color: white;
  padding: 10px 4px;
  border-radius: 4px;
  letter-spacing: 2px;
  font-size: 12px;
  font-weight: bold;
}

/* 中央区域 */
.hw-center {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 20px;
}

/* 右侧 RS485 */
.hw-side-right {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.hw-485-label-v {
  writing-mode: vertical-rl;
  text-orientation: upright;
  background: #607d8b;
  color: white;
  padding: 14px 4px;
  border-radius: 4px;
  letter-spacing: 2px;
  font-size: 12px;
  font-weight: bold;
}

/* 底部继电器行 */
.hw-relay-row {
  text-align: center;
  margin-top: 8px;
}

/* 手动点检面板 */
.manual-panel {
  flex: 1;
  background: white;
  border: 1px solid #808080;
  padding: 16px;
  overflow: auto;
}

.warning-bar {
  background: #ffffcc;
  border: 1px solid #ffcc00;
  padding: 8px;
  color: #c2410c;
  font-weight: bold;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  max-width: 768px;
}

.relay-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
}

.relay-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 底部状态栏 */
.win-status-bar {
  height: 24px;
  background: #f0f0f0;
  border-top: 1px solid #808080;
  display: flex;
  align-items: center;
  font-size: 11px;
  flex-shrink: 0;
}

.status-cell {
  padding: 0 8px;
  border-right: 1px solid #808080;
  height: 100%;
  display: flex;
  align-items: center;
}

.status-ip {
  width: 160px;
}

.ip-text {
  color: #003399;
  margin-left: 4px;
  font-weight: bold;
}

.status-state {
  width: 128px;
}

.state-running {
  color: #16a34a;
  font-weight: bold;
}

.state-ready {
  color: #003399;
  font-weight: bold;
}

.status-cmd {
  flex: 1;
  color: #4b5563;
}

.status-pass {
  width: 256px;
}

.pass-rate {
  color: #16a34a;
  font-weight: bold;
  margin: 0 4px;
}

.status-progress {
  width: 256px;
}

.progress-bar-bg {
  flex: 1;
  height: 12px;
  background: #e6e6e6;
  border: 1px solid #808080;
  box-shadow: inset 1px 1px 2px rgba(0,0,0,0.2);
  margin: 0 8px;
  position: relative;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: linear-gradient(to bottom, #7fe57f 0%, #00d200 50%, #00b300 100%);
  border-right: 1px solid #006400;
  transition: width 0.3s linear;
}

.progress-text {
  color: #006400;
  font-weight: bold;
  font-family: monospace;
}

/* 经典表格行颜色 */
:deep(.win-row-pass) {
  background-color: #dff0d8 !important;
}

:deep(.win-row-fail) {
  background-color: #f2dede !important;
}

/* 经典表格样式 */
:deep(.el-table) {
  --el-table-border-color: #d0d7e5;
  --el-table-header-bg-color: #e3edf7;
  --el-table-header-text-color: #003399;
  --el-table-row-hover-bg-color: #e5f1fb;
  font-size: 12px;
}

:deep(.el-table th.el-table__cell) {
  background: linear-gradient(to bottom, #ffffff 0%, #e3edf7 100%) !important;
  border-right: 1px solid #c0c0c0 !important;
  border-bottom: 1px solid #999 !important;
  font-weight: bold;
  padding: 4px 0 !important;
}

:deep(.el-table td.el-table__cell) {
  padding: 2px 0 !important;
  border-right: 1px solid #e0e0e0;
  border-bottom: 1px solid #e0e0e0;
}

/* 经典 Tree 样式 */
:deep(.el-tree-node__content) {
  height: 22px !important;
  font-size: 12px;
  display: flex;
  align-items: center;
}

:deep(.el-checkbox__inner) {
  border: 1px solid #8f8f8f !important;
  border-radius: 0 !important;
  width: 13px !important;
  height: 13px !important;
  background-color: #fff !important;
  box-shadow: inset 1px 1px 1px rgba(0,0,0,0.08);
  display: flex;
  align-items: center;
  justify-content: center;
}

:deep(.el-checkbox__input.is-focus .el-checkbox__inner) {
  border-color: #0078d7 !important;
}

:deep(.el-checkbox__input.is-checked .el-checkbox__inner),
:deep(.el-checkbox__input.is-indeterminate .el-checkbox__inner) {
  background-color: #fff !important;
  border-color: #8f8f8f !important;
}

:deep(.el-checkbox__input.is-checked .el-checkbox__inner::after) {
  border-color: #000 !important;
  border-width: 1.5px !important;
  border-left: 0 !important;
  border-top: 0 !important;
  height: 7px !important;
  left: 50% !important;
  top: 50% !important;
  transform: translate(-50%, -56%) rotate(45deg) scaleY(1) !important;
  width: 3px !important;
}

:deep(.el-checkbox__input.is-indeterminate .el-checkbox__inner::before) {
  background-color: #000 !important;
  height: 7px !important;
  width: 7px !important;
  top: 2px !important;
  left: 2px !important;
  transform: none !important;
  right: auto !important;
  bottom: auto !important;
}

/* 经典滚动条 */
::-webkit-scrollbar { width: 14px; height: 14px; }
::-webkit-scrollbar-track { background: #f0f0f0; border-left: 1px solid #ccc; }
::-webkit-scrollbar-thumb { background: #cdd5df; border: 1px solid #aeb5be; }
::-webkit-scrollbar-thumb:hover { background: #b0b8c0; }

/* 拖拽调节器 */
.panel-resizer {
  height: 6px;
  background: #cbd5e1;
  cursor: ns-resize;
  width: 100%;
  user-select: none;
  flex-shrink: 0;
  border-top: 1px solid #94a3b8;
  border-bottom: 1px solid #94a3b8;
  margin: 2px 0;
}
.panel-resizer:hover, .panel-resizer.active {
  background: #3b82f6;
  border-color: #2563eb;
}

/* 自动保存日志友情提示 */
.auto-save-tip {
  color: #166534;
  font-size: 11px;
  margin-right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: bold;
}
.auto-save-tip.disabled {
  color: #c2410c;
}

/* 自动保存复选框样式 */
.auto-save-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: bold;
  color: #334155;
  cursor: pointer;
  margin-right: 12px;
  user-select: none;
}
.auto-save-checkbox input[type="checkbox"] {
  width: 13px;
  height: 13px;
  cursor: pointer;
  accent-color: #0078d7;
}

</style>

<style>
/* 全局滚动条样式：避开 scoped 编译导致自定义滚动条伪元素属性不识别问题 */
.terminal-body::-webkit-scrollbar {
  width: 16px;
}
.terminal-body::-webkit-scrollbar-track {
  background: #f1f5f9;
  border-left: 1px solid #cbd5e1;
}
.terminal-body::-webkit-scrollbar-thumb {
  background: #94a3b8;
  border: 3px solid #f1f5f9;
  border-radius: 4px;
}
.terminal-body::-webkit-scrollbar-thumb:hover {
  background: #64748b;
}
</style>
