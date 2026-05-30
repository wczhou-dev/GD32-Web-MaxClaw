<template>
  <div class="ate-page-container">
    <!-- ATE 内部侧边导航 -->
    <aside class="ate-sidebar">
      <div class="ate-sidebar-header">
        <div class="logo-circle"></div>
        <div class="logo-text">
          <h2>环控器 ATE 检定</h2>
          <span>SINGLE DEVICE</span>
        </div>
      </div>
      <ul class="ate-nav-menu">
        <li 
          v-for="tab in tabs" 
          :key="tab.id" 
          :class="['ate-nav-item', { active: currentTab === tab.id }]"
          @click="currentTab = tab.id"
        >
          <span class="ate-nav-icon">{{ tab.icon }}</span>
          <span>{{ tab.name }}</span>
        </li>
      </ul>
      <div class="ate-sidebar-footer">
        当前状态: 
        <span 
          :style="{ color: sysStatusColor, fontWeight: 'bold' }"
        >
          {{ sysStatusText }}
        </span>
      </div>
    </aside>

    <!-- ATE 主内容工作区 -->
    <section class="ate-main-content">
      <!-- 顶部信息栏 -->
      <div class="ate-header-bar">
        <div class="header-title">{{ currentTabName }}</div>
        <div class="header-operator">
          <span class="label">当前检测员:</span>
          <span class="operator-name">{{ operatorName }}</span>
          <el-avatar :size="28" class="op-avatar">OP</el-avatar>
        </div>
      </div>

      <!-- 1. 检定主控台 -->
      <div v-if="currentTab === 'console'" class="tab-panel active-panel">
        <!-- 待测设备基本参数 -->
        <div class="ate-card parameter-card">
          <div class="ate-card-title">🔌 待测设备基本参数录入</div>
          <el-form :inline="true" :model="deviceInfo" size="default" class="param-form">
            <el-form-item label="设备 MAC 地址 / 条形码">
              <el-input v-model="deviceInfo.mac" placeholder="扫码枪录入 MAC" />
            </el-form-item>
            <el-form-item label="硬件主板型号">
              <el-select v-model="deviceInfo.model" style="width: 180px;">
                <option value="sj-encontrol-9301">sj-encontrol-9301 (标准)</option>
                <option value="sj-encontrol-9250">sj-encontrol-9250 (中端)</option>
                <option value="sj-encontrol-9200">sj-encontrol-9200 (简易)</option>
              </el-select>
            </el-form-item>
            <el-form-item label="固件系统版本">
              <el-input v-model="deviceInfo.version" />
            </el-form-item>
            <el-form-item label="测试控制方案">
              <el-select v-model="deviceInfo.scheme" style="width: 180px;">
                <option value="standard">分娩舍标准出厂方案</option>
                <option value="all-peripherals">保育舍全外设动作方案</option>
              </el-select>
            </el-form-item>
          </el-form>
        </div>

        <!-- 树与大表分栏 -->
        <div class="test-columns">
          <!-- 左侧项目选择树 -->
          <div class="tree-sidebar-card">
            <div class="tree-header">
              <span>第 14 章 检定项使能</span>
              <el-button link type="primary" size="small" @click="selectAllItems(true)">全选</el-button>
            </div>
            
            <div class="tree-container">
              <div v-for="grp in testTree" :key="grp.id" class="tree-group">
                <div class="tree-group-title">
                  <el-checkbox 
                    v-model="grp.checked" 
                    :indeterminate="isGroupIndeterminate(grp)"
                    @change="toggleGroupCheck(grp)"
                  >
                    {{ grp.name }}
                  </el-checkbox>
                </div>
                <div class="tree-children">
                  <el-checkbox 
                    v-for="sub in grp.children" 
                    :key="sub.rowId" 
                    v-model="sub.checked"
                    @change="toggleSubCheck(sub)"
                  >
                    {{ sub.name }}
                  </el-checkbox>
                </div>
              </div>
            </div>
          </div>

          <!-- 右侧测试主表格 -->
          <div class="table-container-card">
            <el-table 
              :data="filteredTableData" 
              style="width: 100%; height: 100%;" 
              class="ate-custom-table"
              :row-class-name="tableRowClassName"
            >
              <el-table-column prop="index" label="序号" width="60" />
              <el-table-column prop="chapter" label="规范章节" width="90" />
              <el-table-column prop="name" label="检定测试小项名称" min-width="200" />
              <el-table-column prop="limit" label="物理判定范围/期望阈值" width="220" />
              <el-table-column prop="measured" label="实测物理反馈数据" width="160">
                <template #default="scope">
                  <span :style="{ color: scope.row.status === 'pass' ? '#34d399' : (scope.row.status === 'fail' ? '#f87171' : '') }">
                    {{ scope.row.measured || '-' }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="单项状态/结论" width="130" align="center">
                <template #default="scope">
                  <span 
                    :class="['cell-status-badge', 'status-' + scope.row.status]"
                    @click="handleStatusClick(scope.row)"
                  >
                    {{ getStatusText(scope.row.status) }}
                  </span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!-- 底部控制与日志 -->
        <div class="console-footer-bar">
          <div class="action-buttons">
            <el-button type="success" size="default" :loading="testing" @click="startAutoTest">▶ 连续自动测试</el-button>
            <el-button type="primary" size="default" :disabled="testing" @click="runSingleTest">⚡ 单项重测</el-button>
            <el-button type="danger" size="default" @click="stopAutoTest">🛑 紧急停止</el-button>
            <el-button type="info" size="default" plain @click="saveTestData">保存数据并生成报表</el-button>
          </div>
        </div>

        <!-- 日志控制台 -->
        <div class="log-console-container">
          <div class="log-tab-header">系统检定与调试报文日志</div>
          <div class="log-body" ref="logContainer">
            <div v-for="(log, idx) in logs" :key="idx" class="log-line">
              <span class="log-time">[{{ log.time }}]</span>
              <span :style="{ color: log.color }">{{ log.msg }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 检定判定阈值 -->
      <div v-if="currentTab === 'thresholds'" class="tab-panel active-panel">
        <div class="ate-card">
          <div class="ate-card-title">⚙️ 判定阈值参数与台体端口配置</div>
          <div class="thresholds-grid">
            <div class="config-column">
              <h3>物理传感器输入上限限值</h3>
              <div class="config-item">
                <label>小窗模拟电压比对上限 (V)</label>
                <el-input-number v-model="thresholds.winHigh" :precision="2" :step="0.1" @change="onThresholdChange" />
              </div>
              <div class="config-item">
                <label>小窗模拟电压比对下限 (V)</label>
                <el-input-number v-model="thresholds.winLow" :precision="2" :step="0.1" @change="onThresholdChange" />
              </div>
              <div class="config-item">
                <label>滑窗手动最大运行安全耗时 (秒)</label>
                <el-input-number v-model="thresholds.slideTime" :min="10" :max="100" @change="onThresholdChange" />
              </div>
            </div>

            <div class="config-column">
              <h3>安全保护拦截限制阈值</h3>
              <div class="config-item">
                <label>水帘强关高湿触发阈值 (%)</label>
                <el-input-number v-model="thresholds.wetHumi" :min="50" :max="100" @change="onThresholdChange" />
              </div>
              <div class="config-item">
                <label>继电器单通道接触电阻上限 (Ω)</label>
                <el-input-number v-model="thresholds.relayRes" :precision="2" :step="0.05" />
              </div>
              <div class="config-item">
                <label>通信校验心跳丢包判定 (ms)</label>
                <el-input-number v-model="thresholds.heartbeat" :min="500" :max="10000" :step="500" />
              </div>
            </div>

            <div class="config-column">
              <h3>台体物理通信与网段规划</h3>
              <div class="config-item">
                <label>底板 Modbus TCP 网关地址 IP</label>
                <el-input v-model="thresholds.gatewayIp" placeholder="192.168.1.200" />
              </div>
              <div class="config-item">
                <label>物理隔离高压测试串口号</label>
                <el-input v-model="thresholds.serialPort" placeholder="COM3" />
              </div>
              <div class="config-item">
                <label>上位机 TCP JSON 心跳监听端口</label>
                <el-input-number v-model="thresholds.listenerPort" :min="1000" :max="65535" />
              </div>
            </div>
          </div>
          <div class="config-footer">
            <el-button type="primary" @click="saveThresholdsAlert">💾 保存配置并更新大表判定线</el-button>
          </div>
        </div>
      </div>

      <!-- 3. 出厂历史报表 -->
      <div v-if="currentTab === 'history'" class="tab-panel active-panel">
        <div v-if="!showPdf" class="ate-card">
          <div class="history-header">
            <div class="ate-card-title">📂 已测试历史环控器记录 (出厂归档)</div>
            <div class="history-search">
              <el-input v-model="historyQuery" placeholder="搜索 MAC 或 条形码..." style="width: 220px;" />
              <el-button type="primary">🔍 查询</el-button>
            </div>
          </div>
          <div class="records-wrapper">
            <div v-for="rec in filteredRecords" :key="rec.id" class="record-row">
              <div class="record-details">
                <div class="detail-cell">
                  <span class="lbl">测试时间</span>
                  <span class="val">{{ rec.time }}</span>
                </div>
                <div class="detail-cell">
                  <span class="lbl">被测 MAC 地址</span>
                  <span class="val">{{ rec.mac }}</span>
                </div>
                <div class="detail-cell">
                  <span class="lbl">被测型号</span>
                  <span class="val">{{ rec.model }}</span>
                </div>
                <div class="detail-cell">
                  <span class="lbl">技术员</span>
                  <span class="val">{{ rec.operator }}</span>
                </div>
                <div class="detail-cell">
                  <span class="lbl">判定结论</span>
                  <span class="val" :style="{ color: rec.status === 'PASS' ? '#10b981' : '#ef4444' }">
                    {{ rec.status }}
                  </span>
                </div>
              </div>
              <el-button type="primary" size="small" @click="openPdfReport(rec)">📄 查看检定报告</el-button>
            </div>
          </div>
        </div>

        <!-- A4 PDF 报告预览区 -->
        <div v-else class="pdf-container">
          <div class="pdf-actions">
            <el-button size="default" @click="showPdf = false">&larr; 返回历史列表</el-button>
            <el-button type="success" size="default" @click="printReport">🖨️ 打印报告/条形码</el-button>
          </div>
          <div class="pdf-paper">
            <h2>环境控制器出厂合格检定报告</h2>
            <div class="pdf-meta-info">
              <div><strong>报告编号：</strong> ATE-REPORT-{{ currentPdfRecord.id }}</div>
              <div><strong>检定时间：</strong> {{ currentPdfRecord.time }}</div>
            </div>
            <table class="pdf-details-table">
              <tr>
                <td class="pdf-lbl">被测 MAC 地址</td>
                <td>{{ currentPdfRecord.mac }}</td>
                <td class="pdf-lbl">硬件型号规格</td>
                <td>{{ currentPdfRecord.model }}</td>
              </tr>
              <tr>
                <td class="pdf-lbl">检测技术员</td>
                <td>{{ currentPdfRecord.operator }}</td>
                <td class="pdf-lbl">综合质检结论</td>
                <td :style="{ color: currentPdfRecord.status === 'PASS' ? 'green' : 'red', fontWeight: 'bold' }">
                  {{ currentPdfRecord.status }}
                </td>
              </tr>
            </table>

            <h3 class="pdf-section-title">物理电气与功能参数自检清单：</h3>
            <table class="pdf-items-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>自检物理项</th>
                  <th>规程小节</th>
                  <th>判定阈值范围</th>
                  <th>实测反馈数据</th>
                  <th>判定结论</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1</td>
                  <td>小窗电压手动测试</td>
                  <td>14.2.1</td>
                  <td>全关: {{ thresholds.winHigh }}V±0.2V / 全开: 0V±0.1V</td>
                  <td>全关: 4.98 V | 全开: 0.01 V</td>
                  <td>合格</td>
                </tr>
                <tr>
                  <td>2</td>
                  <td>滑窗行程安全测试</td>
                  <td>14.3.1</td>
                  <td>总行程 {{ thresholds.slideTime }}s±2s</td>
                  <td>29.8 秒</td>
                  <td>合格</td>
                </tr>
                <tr>
                  <td>3</td>
                  <td>风机继电器接触阻抗</td>
                  <td>14.5.1</td>
                  <td>接触电阻 &lt; {{ thresholds.relayRes }} Ω</td>
                  <td>电阻正常 (&lt; 0.12 Ω)</td>
                  <td>{{ currentPdfRecord.status === 'PASS' ? '合格' : '不合格 (阻抗过高)' }}</td>
                </tr>
                <tr>
                  <td>4</td>
                  <td>水帘高湿自动拦截</td>
                  <td>14.9.2</td>
                  <td>湿度 &gt; {{ thresholds.wetHumi }}% 强切</td>
                  <td>实测湿度 88% -> 继电器自动释放</td>
                  <td>合格</td>
                </tr>
              </tbody>
            </table>
            <div class="pdf-signature-area">
              <div><strong>质检技术员签字：</strong>_________________</div>
              <div><strong>品质部核准盖章：</strong>_________________</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. 台体手动点检 -->
      <div v-if="currentTab === 'debugging'" class="tab-panel active-panel">
        <div class="ate-card">
          <div class="ate-card-title">🔧 台体独立通道物理点检操控板</div>
          <div class="debugging-layout">
            <div class="ctrl-panel">
              <h4 class="sub-sec-title">手动继电器开闭输出 (DO 1~8)</h4>
              <div class="relay-buttons-grid">
                <button 
                  v-for="relay in relayStates" 
                  :key="relay.id" 
                  :class="['manual-relay-btn', { active: relay.state }]"
                  @click="toggleRelayState(relay)"
                >
                  继电器 {{ relay.id }} ({{ relay.name }})
                </button>
              </div>

              <h4 class="sub-sec-title" style="margin-top: 24px;">模拟占空比输出设定 (AO 1)</h4>
              <div class="ao-slider-item">
                <div class="ao-label">
                  <span>变频风机阶梯驱动 (0V ~ 10V)</span>
                  <span class="ao-val-display">{{ (aoValue / 10).toFixed(1) }} V</span>
                </div>
                <el-slider v-model="aoValue" :max="100" @input="onAoSliderInput" />
              </div>
            </div>

            <div class="wave-panel">
              <h4 class="sub-sec-title">接触电阻及电压回读阻抗示波器</h4>
              <div class="oscilloscope-viewport">
                <span class="scope-tip">正在实时监测 ATE 隔离采样物理电平状态...</span>
                <!-- 示波器网格线条模拟 -->
                <div class="scope-grid-lines"></div>
              </div>
              <p class="scope-info-text">
                提示：手动开启继电器或滑动模拟输出电压，可以从上方阻抗示波器回读通道两端接触状态的反馈，用于点检台体夹具是否有气路松动或接触不良。
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. 技术员授权 -->
      <div v-if="currentTab === 'auth'" class="tab-panel active-panel">
        <div class="ate-card login-card-wrapper">
          <div class="login-card">
            <div class="login-header">👤 检测技术员安全签名授权</div>
            <el-form label-position="top">
              <el-form-item label="技术员测试工号 (Operator ID)">
                <el-input v-model="inputOperator" placeholder="请输入工号" />
              </el-form-item>
              <el-form-item label="安全防呆授权密码">
                <el-input v-model="inputPassword" type="password" placeholder="请输入密码" show-password />
              </el-form-item>
              <el-button type="primary" class="login-submit-btn" @click="handleOperatorLogin">
                安全登录并解锁高级检定数据库
              </el-button>
            </el-form>
          </div>
        </div>
      </div>
    </section>

    <!-- 异常故障排查诊断浮窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="'⚠️ 检定项目不合格排障诊断：' + activeErrorItem.name"
      width="560px"
      custom-class="ate-custom-dialog"
    >
      <div class="dialog-body-content">
        <p><strong>异常物理故障描述：</strong></p>
        <div class="desc-box">{{ activeErrorItem.desc }}</div>
        <p style="margin-top: 14px;"><strong>对应底板下位机 C 语言全局变量/结构体上下文：</strong></p>
        <pre class="code-box"><code>{{ activeErrorItem.code }}</code></pre>
        <p style="margin-top: 14px; font-size: 12px; color: #9ca3af;">
          排故方向：请使用万用表测量该端继电器吸合阻值。如果怀疑是硬件误判，双击主表中该红格行可实现单项就地重测。
        </p>
      </div>
      <template #footer>
        <span class="dialog-footer">
          <el-button type="primary" @click="dialogVisible = false">关闭窗口</el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, nextTick } from 'vue'

// 标签项定义
const tabs = [
  { id: 'console', name: '检定主控台', icon: '📊' },
  { id: 'thresholds', name: '检定判定阈值', icon: '⚙️' },
  { id: 'history', name: '出厂历史报表', icon: '📂' },
  { id: 'debugging', name: '台体手动点检', icon: '🔧' },
  { id: 'auth', name: '技术员授权', icon: '👤' }
]
const currentTab = ref('console')
const currentTabName = computed(() => {
  const t = tabs.find(item => item.id === currentTab.value)
  return t ? `${t.name} - 单台设备全量自检` : ''
})

// 操作员名称
const operatorName = ref('Operator_02')
const inputOperator = ref('Operator_02')
const inputPassword = ref('******')

// 被测设备参数
const deviceInfo = reactive({
  mac: '00:11:22:AA:33:FF',
  model: 'sj-encontrol-9301',
  version: 'v1.2.8_build_20260529',
  scheme: 'standard'
})

// 判定阈值配置
const thresholds = reactive({
  winHigh: 5.20,
  winLow: 4.80,
  slideTime: 30,
  wetHumi: 85,
  relayRes: 0.50,
  heartbeat: 3000,
  gatewayIp: '192.168.1.200',
  serialPort: 'COM3',
  listenerPort: 9001
})

// 系统运行状态
const testing = ref(false)
const sysStatusText = computed(() => {
  if (testing.value) return '检定中...'
  return '就绪'
})
const sysStatusColor = computed(() => {
  if (testing.value) return 'var(--accent-yellow)'
  return 'var(--accent-green)'
})

// 项目选择树
const testTree = ref([
  {
    id: 'grp-14-2',
    name: '14.2 小窗自检模块',
    checked: true,
    children: [
      { rowId: 'row-14-2-1', name: '14.2.1 小窗手动控制电压自检', checked: true },
      { rowId: 'row-14-2-2', name: '14.2.2 小窗自动温控开度自检', checked: true }
    ]
  },
  {
    id: 'grp-14-3',
    name: '14.3 滑窗自检模块',
    checked: true,
    children: [
      { rowId: 'row-14-3-1', name: '14.3.1 滑窗手动控制行程自检', checked: true },
      { rowId: 'row-14-3-2', name: '14.3.2 滑窗自动控制压差自检', checked: true }
    ]
  },
  {
    id: 'grp-14-5',
    name: '14.5 风机控制模块',
    checked: true,
    children: [
      { rowId: 'row-14-5-1', name: '14.5.1 风机手动接触电阻自检', checked: true },
      { rowId: 'row-14-5-2', name: '14.5.2 变频风机阶梯驱动控制', checked: true }
    ]
  },
  {
    id: 'grp-14-9',
    name: '14.9 水帘控制模块',
    checked: true,
    children: [
      { rowId: 'row-14-9-1', name: '14.9.1 水帘手动控制自检', checked: true },
      { rowId: 'row-14-9-2', name: '14.9.2 水帘高湿保护闭环测试', checked: true }
    ]
  }
])

// 大表行数据
const tableData = ref([
  { id: 1, rowId: 'row-14-2-1', chapter: '14.2.1', name: '小窗手动控制自检 (1:1电压反馈)', limitKey: 'win_voltage', limit: '', measured: '', status: 'pending', passVal: '全关:4.98V 全开:0.01V', failVal: '全关:3.24V (偏差过大)', delay: 800 },
  { id: 2, rowId: 'row-14-2-2', chapter: '14.2.2', name: '小窗自动温控开度自检 (步进校验)', limitKey: '', limit: '小窗行程步进平滑无卡涩', measured: '', status: 'pending', passVal: '步进正常 35%', failVal: '', delay: 800 },
  { id: 3, rowId: 'row-14-3-1', chapter: '14.3.1', name: '滑窗手动控制行程安全校验', limitKey: 'slide_time', limit: '', measured: '', status: 'pending', passVal: '总耗时:29.8s', failVal: '', delay: 900 },
  { id: 4, rowId: 'row-14-3-2', chapter: '14.3.2', name: '滑窗自动控制防抖与死区比对', limitKey: '', limit: '负压死区防抖阀值限制正常', measured: '', status: 'pending', passVal: '死区电压比对:12Pa', failVal: '', delay: 700 },
  { id: 5, rowId: 'row-14-5-1', chapter: '14.5.1', name: '风机手动接触电阻测试 (8路继电器)', limitKey: 'relay_res', limit: '', measured: '', status: 'pending', passVal: '8路接触电阻均<0.12Ω', failVal: '风机3触点阻值:148Ω', delay: 1000 },
  { id: 6, rowId: 'row-14-5-2', chapter: '14.5.2', name: '变频风机阶梯驱动控制自检', limitKey: '', limit: 'PWM 占空比阶梯步进正常', measured: '', status: 'pending', passVal: '各占空比输出一致', failVal: '', delay: 800 },
  { id: 7, rowId: 'row-14-9-1', chapter: '14.9.1', name: '水帘手动控制动作自检 (常开反馈)', limitKey: '', limit: '水泵吸合辅助常开反馈5V', measured: '', status: 'pending', passVal: '动作反馈5.01V', failVal: '', delay: 700 },
  { id: 8, rowId: 'row-14-9-2', chapter: '14.9.2', name: '水帘高湿自动锁定保护闭环测试', limitKey: 'wet_humidity', limit: '', measured: '', status: 'pending', passVal: '湿度过高强断正常 (3.0s)', failVal: '', delay: 900 }
])

// 初始化表格期望范围显示
const initTableLimits = () => {
  tableData.value.forEach(row => {
    if (row.limitKey === 'win_voltage') {
      row.limit = `全关:${thresholds.winHigh.toFixed(2)}V±0.2V 全开:0V±0.1V`
    } else if (row.limitKey === 'slide_time') {
      row.limit = `安全动作时间 ${thresholds.slideTime}s±2s`
    } else if (row.limitKey === 'relay_res') {
      row.limit = `接触电阻 < ${thresholds.relayRes.toFixed(2)} Ω`
    } else if (row.limitKey === 'wet_humidity') {
      row.limit = `环境湿度 > ${thresholds.wetHumi}% 自动强切水泵`
    }
  })
}

// 判定阈值改变时同步更新大表
const onThresholdChange = () => {
  initTableLimits()
}

// 树节点勾选状态联动
const isGroupIndeterminate = (grp) => {
  const checkedCount = grp.children.filter(c => c.checked).length
  return checkedCount > 0 && checkedCount < grp.children.length
}

const toggleGroupCheck = (grp) => {
  grp.children.forEach(c => {
    c.checked = grp.checked
    syncRowSkip(c.rowId, c.checked)
  })
}

const toggleSubCheck = (sub) => {
  const grp = testTree.value.find(g => g.children.some(c => c.rowId === sub.rowId))
  if (grp) {
    grp.checked = grp.children.every(c => c.checked)
  }
  syncRowSkip(sub.rowId, sub.checked)
}

const syncRowSkip = (rowId, checked) => {
  const row = tableData.value.find(r => r.rowId === rowId)
  if (row) {
    row.status = checked ? 'pending' : 'skip'
    if (!checked) {
      row.measured = ''
    }
  }
}

const selectAllItems = (checked) => {
  testTree.value.forEach(grp => {
    grp.checked = checked
    toggleGroupCheck(grp)
  })
}

// 表格过滤数据（即所有项，只是用样式控制是否跳过）
const filteredTableData = computed(() => {
  return tableData.value.map((item, idx) => ({
    ...item,
    index: idx + 1
  }))
})

// 样式类绑定
const tableRowClassName = ({ row }) => {
  if (row.status === 'skip') {
    return 'row-skip'
  }
  return ''
}

// 状态文字转换
const getStatusText = (status) => {
  const map = {
    pending: '等待检测',
    testing: '测试中...',
    pass: '合格',
    fail: '不合格',
    skip: '已跳过'
  }
  return map[status] || status
}

// 日志系统
const logs = ref([])
const logContainer = ref(null)

const addLog = (msg, color = '#ffffff') => {
  const now = new Date()
  const time = now.toTimeString().split(' ')[0]
  logs.value.push({ time, msg, color })
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
}

// 自动测试流程 - 调用后端 TestManager
let timerId = null
let currentStepIdx = 0

const startAutoTest = () => {
  if (testing.value) return

  // 获取选中的测试项
  const selectedItemIds = tableData.value
    .filter(r => r.status !== 'skip')
    .map(r => r.id)

  if (selectedItemIds.length === 0) {
    addLog('⚠️ 请至少选择一个测试项', '#f59e0b')
    return
  }

  testing.value = true
  currentStepIdx = 0
  addLog('====================== 启动 ATE 上位机物理检定队列 ======================', '#f59e0b')
  addLog(`被测 MAC: ${deviceInfo.mac} | 主板型号: ${deviceInfo.model} | 方案: ${deviceInfo.scheme}`, '#3b82f6')

  // 重置状态
  tableData.value.forEach(r => {
    if (r.status !== 'skip') {
      r.status = 'pending'
      r.measured = ''
    }
  })

  // 调用 store 启动测试
  deviceStore.startTest({
    deviceIp: deviceStore.selectedDeviceIp,
    operatorInputId: operatorName.value,
    selectedItemIds,
    deviceModel: deviceInfo.model,
    workOrder: deviceInfo.workOrder || '',
  })

  addLog('已发送启动请求到后端...', '#3b82f6')
}

const runNextStep = () => {
  // 此函数保留用于本地 UI 更新，实际测试由后端驱动
  if (!testing.value) return

  let step = null
  while (currentStepIdx < tableData.value.length) {
    const next = tableData.value[currentStepIdx]
    if (next.status !== 'skip') {
      step = next
      break
    }
    currentStepIdx++
  }

  if (!step) {
    addLog('====================== ATE 队列自检完毕 ======================', '#10b981')
    testing.value = false
    return
  }
}

const stopAutoTest = () => {
  testing.value = false
  addLog('🛑 操作员执行紧急停止！', '#ef4444')

  // 调用 store 停止测试
  deviceStore.stopTest()

  tableData.value.forEach(r => {
    if (r.status === 'testing') {
      r.status = 'pending'
    }
  })
}

const runSingleTest = () => {
  addLog('就地单项电气重测中...', '#e5e7eb')
  deviceStore.retryFailed()
}

// 保存数据
const saveTestData = () => {
  const hasFail = tableData.value.some(r => r.status === 'fail')
  const newRec = {
    id: Date.now(),
    time: new Date().toLocaleString(),
    mac: deviceInfo.mac,
    model: deviceInfo.model,
    operator: operatorName.value,
    status: hasFail ? 'FAIL' : 'PASS'
  }
  historyRecords.value.unshift(newRec)
  addLog(`[存盘] 设备 MAC:${deviceInfo.mac} 物理测试数据成功持久化至本地 SQLite 数据库。`, '#10b981')
  alert('检定数据成功持久化保存！可在“出厂历史报表”中查询并打印质检单。')
}

// 诊断弹窗
const dialogVisible = ref(false)
const activeErrorItem = ref({ name: '', desc: '', code: '' })

const handleStatusClick = (row) => {
  if (row.status !== 'fail') return
  
  if (row.rowId === 'row-14-2-1') {
    activeErrorItem.value = {
      name: '小窗手动电压自检',
      desc: '小窗行程反馈发出全关指令，模拟AI端实测回读电压为 3.24V，偏离设定的 5V±0.2V 判定限。可能原因：小窗限位滑轨卡涩阻值偏差，或底板AI分压阻抗老化接触不良。',
      code: 'App_Save.Window[DO_SmallWindow].Now_Position = 0;\nApp_Run.portAI[AI_SmallWindow].SampleVoltage = 3240 mV; // 正常应为 4800~5200 mV'
    }
  } else if (row.rowId === 'row-14-5-1') {
    activeErrorItem.value = {
      name: '风机继电器接触阻抗自检',
      desc: '定速风机 3 闭合，高压隔离板回测辅助触点内阻为 148Ω，远超设定的 0.5Ω 安全门限，拦截原因为继电器内胆打弧碳化。',
      code: 'App_Run.Supplyfan[2].FixedState = 1;\nApp_Run.LGT.RelayNum = 3;\nATE_Sensor_Voltage = 0.24 V; // 高电平常开信号未闭合'
    }
  }
  dialogVisible.value = true
}

// 判定页面
const saveThresholdsAlert = () => {
  addLog('系统配置参数写入完毕。最新阈值限已覆盖全局自检判定公式。', '#10b981')
  alert('参数配置更新成功，已刷新测试大表！')
}

// 历史记录
const historyRecords = ref([
  { id: 1001, time: '2026-05-29 14:32:01', mac: '00:11:22:AA:33:EE', model: 'sj-encontrol-9301', operator: 'Operator_02', status: 'PASS' },
  { id: 1002, time: '2026-05-29 15:10:45', mac: '00:11:22:AA:33:88', model: 'sj-encontrol-9250', operator: 'Operator_02', status: 'FAIL' }
])
const historyQuery = ref('')
const filteredRecords = computed(() => {
  if (!historyQuery.value) return historyRecords.value
  return historyRecords.value.filter(r => r.mac.includes(historyQuery.value))
})

// PDF报表生成
const showPdf = ref(false)
const currentPdfRecord = ref({})
const openPdfReport = (rec) => {
  currentPdfRecord.value = rec
  showPdf.value = true
}
const printReport = () => {
  window.print()
}

// 继电器手动点检模拟
const relayStates = ref([
  { id: 1, name: '负压风机1', state: false },
  { id: 2, name: '负压风机2', state: false },
  { id: 3, name: '定速风机3', state: false },
  { id: 4, name: '喷淋继电器', state: false },
  { id: 5, name: '照明继电器', state: false },
  { id: 6, name: '加热1继电器', state: false },
  { id: 7, name: '水帘水泵', state: false },
  { id: 8, name: '辅助报警', state: false }
])
const aoValue = ref(0)

const toggleRelayState = (relay) => {
  relay.state = !relay.state
  addLog(`点检控制：下发继电器通道 DO ${relay.id} -> ${relay.state ? '【吸合】' : '【断开】'}`, relay.state ? '#10b981' : '#f59e0b')
}

const onAoSliderInput = (val) => {
  addLog(`点检控制：更新模拟输出 AO 1 开度电压设定 -> ${(val / 10).toFixed(1)} V`, '#3b82f6')
}

// 授权登录
const handleOperatorLogin = () => {
  operatorName.value = inputOperator.value
  addLog(`操作授权：技术员 [${inputOperator.value}] 安全登录成功，解锁系统检定数据库。`, '#10b981')
  alert(`切换操作人员成功：当前技术员变更为 ${inputOperator.value}`)
  currentTab.value = 'console'
}

onMounted(() => {
  initTableLimits()
  addLog('系统初始化完毕。Modbus TCP 上位机侦听已就绪。')
})
</script>

<style scoped>
/* 整个 ATE 页面的全局容器，基于 Glassmorphism (暗色毛玻璃磨砂风格) */
.ate-page-container {
  display: flex;
  height: calc(100vh - 100px); /* 留出顶部 GD32 环控系统主标题的高度 */
  background: #080c14;
  color: #f3f4f6;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

/* ATE 侧边导航栏 */
.ate-sidebar {
  width: 200px;
  background: rgba(13, 20, 35, 0.95);
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  height: 100%;
}

.ate-sidebar-header {
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.logo-circle {
  width: 20px;
  height: 20px;
  background: linear-gradient(135deg, #06b6d4, #3b82f6);
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(6, 182, 212, 0.5);
}

.logo-text h2 {
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  margin: 0;
}

.logo-text span {
  font-size: 9px;
  color: #06b6d4;
  letter-spacing: 0.5px;
}

.ate-nav-menu {
  list-style: none;
  padding: 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.ate-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  color: #9ca3af;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.ate-nav-item:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.03);
}

.ate-nav-item.active {
  color: #fff;
  background: linear-gradient(90deg, rgba(6, 182, 212, 0.15), rgba(59, 130, 246, 0.05));
  border-left: 3px solid #06b6d4;
}

.ate-nav-icon {
  font-size: 14px;
}

.ate-sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 11px;
  color: #9ca3af;
}

/* 主内容工作区 */
.ate-main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background-image: radial-gradient(circle at 10% 10%, rgba(6, 182, 212, 0.02) 0%, transparent 40%);
}

/* 顶部状态栏 */
.ate-header-bar {
  height: 50px;
  background: rgba(10, 15, 26, 0.5);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.header-title {
  font-size: 13.5px;
  font-weight: 600;
  color: #e5e7eb;
}

.header-operator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.header-operator .label {
  color: #9ca3af;
}

.header-operator .operator-name {
  font-weight: 600;
  color: #fff;
}

.op-avatar {
  background: #1e293b;
  border: 1px solid #06b6d4;
  color: #06b6d4;
  font-size: 10px;
  font-weight: bold;
}

/* 页面面板 */
.tab-panel {
  display: none;
  flex: 1;
  padding: 16px;
  overflow: hidden;
}

.tab-panel.active-panel {
  display: flex;
  flex-direction: column;
}

/* 通用卡片 */
.ate-card {
  background: rgba(17, 24, 39, 0.7);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 14px;
}

.ate-card-title {
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 12px;
}

/* 待测设备基本参数 */
.param-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.param-form :deep(.el-form-item) {
  margin-right: 0;
  margin-bottom: 4px;
}

.param-form :deep(.el-form-item__label) {
  color: #9ca3af;
  font-size: 12px;
  padding-bottom: 4px;
}

.param-form :deep(.el-input__inner),
.param-form :deep(.el-select__wrapper) {
  background: rgba(10, 15, 26, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #fff;
}

/* 树和大表两栏布局 */
.test-columns {
  display: flex;
  gap: 14px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  margin-bottom: 14px;
}

.tree-sidebar-card {
  width: 250px;
  background: rgba(10, 15, 26, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  padding: 12px;
}

.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11.5px;
  font-weight: bold;
  color: #9ca3af;
  margin-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 6px;
}

.tree-container {
  flex: 1;
  overflow-y: auto;
}

.tree-group {
  margin-bottom: 12px;
}

.tree-group-title {
  margin-bottom: 4px;
}

.tree-group-title :deep(.el-checkbox__label) {
  font-weight: bold;
  color: #fff;
  font-size: 12.5px;
}

.tree-children {
  margin-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tree-children :deep(.el-checkbox__label) {
  color: #9ca3af;
  font-size: 11.5px;
}

.table-container-card {
  flex: 1;
  background: rgba(17, 24, 39, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  overflow: hidden;
}

/* 自定义表格样式，以契合暗色背景 */
.ate-custom-table :deep(tr) {
  background: transparent;
}

.ate-custom-table :deep(th) {
  background: rgba(10, 15, 26, 0.95);
  color: #9ca3af;
  border-bottom: 2px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
  padding: 8px 0;
}

.ate-custom-table :deep(td) {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  color: #e5e7eb;
  padding: 6px 0;
}

.ate-custom-table :deep(.row-skip) {
  opacity: 0.25;
  pointer-events: none;
}

/* 状态徽标 */
.cell-status-badge {
  border-radius: 4px;
  padding: 3px 8px;
  font-weight: 600;
  display: inline-block;
  width: 90px;
  font-size: 10.5px;
  text-align: center;
  border: 1px solid transparent;
  user-select: none;
}

.status-pending { background: rgba(255, 255, 255, 0.03); border-color: rgba(255, 255, 255, 0.06); color: #9ca3af; }
.status-testing { background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.35); color: #f59e0b; animation: tablePulse 1.5s infinite; }
.status-pass { background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.35); color: #34d399; }
.status-fail { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.35); color: #f87171; cursor: pointer; }
.status-skip { background: rgba(255, 255, 255, 0.01); color: rgba(255, 255, 255, 0.2); text-decoration: line-through; }

@keyframes tablePulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}

/* 底部操作 */
.console-footer-bar {
  margin-bottom: 12px;
}

.action-buttons {
  display: flex;
  gap: 10px;
}

/* 日志控制台 */
.log-console-container {
  height: 120px;
  background: #06090f;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: 'Consolas', monospace;
}

.log-tab-header {
  height: 28px;
  background: #0c111d;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding: 4px 12px;
  font-size: 11px;
  color: #06b6d4;
  font-weight: bold;
}

.log-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  font-size: 11px;
  line-height: 1.4;
}

.log-line {
  margin-bottom: 2px;
}

.log-time {
  color: #3b82f6;
  margin-right: 8px;
}

/* 阈值配置面板 */
.thresholds-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 20px;
  margin-bottom: 20px;
}

.config-column h3 {
  font-size: 13px;
  color: #06b6d4;
  margin-bottom: 12px;
  border-left: 2px solid #06b6d4;
  padding-left: 8px;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.config-item label {
  font-size: 11.5px;
  color: #9ca3af;
}

.config-item :deep(.el-input-number),
.config-item :deep(.el-input) {
  width: 100%;
}

.config-footer {
  text-align: right;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 14px;
}

/* 历史列表页 */
.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.history-search {
  display: flex;
  gap: 8px;
}

.records-wrapper {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 400px;
  overflow-y: auto;
}

.record-row {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.record-details {
  display: flex;
  gap: 24px;
}

.detail-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.detail-cell .lbl {
  font-size: 10px;
  color: #9ca3af;
}

.detail-cell .val {
  font-size: 12px;
  font-weight: 600;
}

/* PDF报告样式 */
.pdf-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.pdf-actions {
  display: flex;
  justify-content: space-between;
}

.pdf-paper {
  background: #ffffff;
  color: #1f2937;
  padding: 30px;
  border-radius: 8px;
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  font-family: 'SimSun', serif;
}

.pdf-paper h2 {
  text-align: center;
  margin-bottom: 16px;
  border-bottom: 2px solid #1f2937;
  padding-bottom: 6px;
  font-size: 18px;
  font-weight: bold;
}

.pdf-meta-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-bottom: 12px;
}

.pdf-details-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
  font-size: 11px;
}

.pdf-details-table td {
  border: 1px solid #1f2937;
  padding: 6px;
}

.pdf-lbl {
  background: #f3f4f6;
  font-weight: bold;
  width: 120px;
}

.pdf-section-title {
  font-size: 12px;
  margin-top: 14px;
  margin-bottom: 6px;
  font-weight: bold;
}

.pdf-items-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}

.pdf-items-table th, 
.pdf-items-table td {
  border: 1px solid #1f2937;
  padding: 6px;
}

.pdf-items-table th {
  background: #f3f4f6;
}

.pdf-signature-area {
  margin-top: 24px;
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}

/* 手动点检面板 */
.debugging-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.ctrl-panel {
  background: rgba(10, 15, 26, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  padding: 16px;
}

.sub-sec-title {
  font-size: 12.5px;
  color: #06b6d4;
  margin-bottom: 10px;
}

.relay-buttons-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
}

.manual-relay-btn {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 10px 4px;
  font-size: 11.5px;
  color: #e5e7eb;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
}

.manual-relay-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}

.manual-relay-btn.active {
  background: rgba(16, 185, 129, 0.15);
  border-color: #10b981;
  color: #34d399;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.2);
}

.ao-slider-item {
  background: rgba(0,0,0,0.2);
  padding: 12px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.04);
}

.ao-label {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: #9ca3af;
  margin-bottom: 6px;
}

.ao-val-display {
  color: #06b6d4;
  font-weight: bold;
}

.wave-panel {
  display: flex;
  flex-direction: column;
}

.oscilloscope-viewport {
  height: 200px;
  background: #020617;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scope-tip {
  color: #9ca3af;
  font-size: 11px;
  z-index: 2;
}

/* 示波器网格纹理效果 */
.scope-grid-lines {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-image: linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 20px 20px;
}

.scope-info-text {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 10px;
}

/* 授权登录面板 */
.login-card-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 80%;
}

.login-card {
  width: 360px;
  background: rgba(10, 15, 26, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 24px;
}

.login-header {
  font-size: 14.5px;
  font-weight: bold;
  text-align: center;
  margin-bottom: 18px;
  color: #fff;
}

.login-submit-btn {
  width: 100%;
  margin-top: 10px;
}

.login-card :deep(.el-form-item__label) {
  color: #9ca3af;
  font-size: 12px;
  padding-bottom: 4px;
}

/* 弹窗对话框暗色重绘 */
:deep(.ate-custom-dialog) {
  background: rgba(15, 23, 42, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

:deep(.ate-custom-dialog .el-dialog__title) {
  color: #ef4444;
  font-weight: bold;
  font-size: 14.5px;
}

.desc-box {
  background: rgba(239, 68, 68, 0.05);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 6px;
  padding: 10px;
  color: #f87171;
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 12px;
}

.code-box {
  background: #000000;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 12px;
  font-family: 'Consolas', monospace;
  font-size: 11px;
  color: #fda4af;
  white-space: pre-wrap;
}
</style>
