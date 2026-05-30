import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useDeviceStore = defineStore('device', () => {
  const wsConnected = ref(false)
  const devices = ref([])
  const tempData = ref(Array(16).fill(null))
  const humiData = ref(Array(16).fill(null))
  const co2Data = ref(Array(8).fill(null))
  const nh3Data = ref(Array(4).fill(null))
  const windData = ref(Array(12).fill(null))
  const relayStatus = ref(Array(22).fill(false))
  const digitalInputs = ref(Array(10).fill(false))
  const outdoorTemp = ref(null)
  const outdoorHumi = ref(null)
  const pressureData = ref(Array(4).fill(null))
  const otaProgress = ref(0)
  const otaStatus = ref(0)
  const lastUpdate = ref(null)
  const selectedDeviceIp = ref('')
  let ws = null
  const onlineDevices = computed(() => devices.value.filter(d => d.status === 'CONNECTED'))

  // ============================================================
  // ATE 自动化测试状态
  // ============================================================

  /** 当前 ATE 会话 */
  const ateSession = ref(null)

  /** ATE 测试进度 */
  const ateProgress = ref(0)

  /** ATE 测试状态：idle/running/pass/fail/aborted/timeout */
  const ateStatus = ref('idle')

  /** ATE 当前测试项 ID */
  const ateCurrentItemId = ref(null)

  /** ATE 测试项 timeline：Map<itemId, { state, startTime, endTime, errorCode }> */
  const ateTimeline = ref({})

  /** ATE 测试摘要：{ total, passed, failed, skipped } */
  const ateSummary = ref({ total: 0, passed: 0, failed: 0, skipped: 0 })

  /** ATE 日志列表 */
  const ateLogs = ref([])

  /** ATE 历史报告列表 */
  const ateReports = ref([])

  /** ATE 原始帧日志（调试用） */
  const ateRawFrames = ref([])

  /** ATE 是否开启报文调试 */
  const ateDebugMode = ref(false)

  /** ATE 设备连接状态 */
  const ateDeviceConnected = ref(false)

  function connect() {
    if (ws) return
    ws = new WebSocket(`ws://${window.location.hostname}:3001`)
    ws.onopen = () => { wsConnected.value = true }
    ws.onclose = () => { wsConnected.value = false; ws = null; setTimeout(connect, 5000) }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)

        // ATE 测试消息处理
        if (msg.type && msg.type.startsWith('test_')) {
          handleAteMessage(msg)
        } else if (msg.type === 'ate_device_log') {
          handleAteLog(msg)
        } else if (msg.type === 'ate_raw_frame') {
          handleAteRawFrame(msg)
        } else if (msg.type === 'sensor_data') {
          if (msg.data.temp) tempData.value = msg.data.temp
          if (msg.data.humi) humiData.value = msg.data.humi
          if (msg.data.co2) co2Data.value = msg.data.co2
          if (msg.data.nh3) nh3Data.value = msg.data.nh3
          if (msg.data.wind) windData.value = msg.data.wind
          if (msg.data.relays) relayStatus.value = msg.data.relays
          if (msg.data.digitalInputs) digitalInputs.value = msg.data.digitalInputs
          if (msg.data.outdoorTemp) outdoorTemp.value = msg.data.outdoorTemp
          if (msg.data.outdoorHumi) outdoorHumi.value = msg.data.outdoorHumi
          if (msg.data.pressure) pressureData.value = msg.data.pressure
        } else if (msg.type === 'device_list') {
          devices.value = msg.devices.map(d => ({
            name: d.name,
            ip: d.ip,
            status: d.status || 'DISCONNECTED'
          }))
          // 如果当前没选设备，默认选第一个
          if (!selectedDeviceIp.value && devices.value.length > 0) {
            selectedDeviceIp.value = devices.value[0].ip
          }
        } else if (msg.type === 'device_status') {
          const i = devices.value.findIndex(d => d.ip === msg.deviceIp)
          if (i >= 0) devices.value[i].status = msg.status
        } else if (msg.type === 'ota_progress') {
          otaProgress.value = msg.progress
          otaStatus.value = msg.status
        }
        lastUpdate.value = new Date()
      } catch (err) { console.error('[Store] Error:', err) }
    }

    // ATE 消息处理函数
    function handleAteMessage(msg) {
      const { type, sessionId, state, progress, overallStatus, currentItemId, summary, timeline } = msg

      // 更新会话状态
      if (sessionId && !ateSession.value) {
        ateSession.value = { sessionId, deviceIp: msg.deviceIp }
      }

      // 更新进度
      if (progress !== undefined) {
        ateProgress.value = progress
      }

      // 更新状态
      if (state) {
        ateStatus.value = state
      }
      if (overallStatus !== undefined) {
        const statusMap = { 0: 'idle', 1: 'running', 2: 'pass', 3: 'fail', 4: 'aborted', 5: 'timeout' }
        ateStatus.value = statusMap[overallStatus] || 'idle'
      }

      // 更新当前测试项
      if (currentItemId !== undefined) {
        ateCurrentItemId.value = currentItemId
      }

      // 更新摘要
      if (summary) {
        ateSummary.value = summary
      }

      // 更新 timeline
      if (timeline) {
        ateTimeline.value = timeline
      }

      // 测试完成
      if (type === 'test_test_finished') {
        ateStatus.value = overallStatus === 2 ? 'pass' : 'fail'
        ateSession.value = null
      }

      // 测试错误
      if (type === 'test_test_error') {
        ateStatus.value = 'error'
        ateLogs.value.push({
          level: 'error',
          message: msg.message || '测试错误',
          timestamp: Date.now()
        })
      }
    }

    // ATE 日志处理
    function handleAteLog(msg) {
      ateLogs.value.push({
        level: msg.level || 'info',
        message: msg.message,
        timestamp: msg.timestamp || Date.now()
      })
      // 保留最近 500 条日志
      if (ateLogs.value.length > 500) {
        ateLogs.value = ateLogs.value.slice(-500)
      }
    }

    // ATE 原始帧处理
    function handleAteRawFrame(msg) {
      if (ateDebugMode.value) {
        ateRawFrames.value.push({
          direction: msg.direction,
          hex: msg.hex,
          timestamp: msg.timestamp || Date.now()
        })
        // 保留最近 100 条
        if (ateRawFrames.value.length > 100) {
          ateRawFrames.value = ateRawFrames.value.slice(-100)
        }
      }
    }

    // 连接成功后主动请求一次设备列表
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'get_devices' }))
    })
  }

  function controlRelay(deviceIp, relayIndex, value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'relay_control', relayIndex, value, deviceIp }))
  }

  function triggerOTA(deviceIp, version) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'ota_start', version, deviceIp }))
  }

  // ============================================================
  // ATE 自动化测试方法
  // ============================================================

  /**
   * 启动 ATE 测试
   * @param {object} options
   * @param {string} options.deviceIp - 设备 IP
   * @param {string} options.operatorInputId - 操作员工号
   * @param {number[]} options.selectedItemIds - 选中的测试项 ID
   * @param {string} options.deviceModel - 设备型号
   * @param {string} options.workOrder - 工单号
   */
  function startTest(options) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'start_test_request',
      ...options
    }))
    ateStatus.value = 'starting'
  }

  /**
   * 停止 ATE 测试
   */
  function stopTest() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!ateSession.value) return
    ws.send(JSON.stringify({
      type: 'stop_test_request',
      deviceIp: ateSession.value.deviceIp,
      sessionId: ateSession.value.sessionId
    }))
  }

  /**
   * 复位 ATE 测试
   */
  function resetTest() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!ateSession.value) return
    ws.send(JSON.stringify({
      type: 'reset_test_request',
      deviceIp: ateSession.value.deviceIp,
      sessionId: ateSession.value.sessionId
    }))
  }

  /**
   * 重测失败项
   */
  function retryFailed() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!ateSession.value) return
    ws.send(JSON.stringify({
      type: 'retry_failed_request',
      deviceIp: ateSession.value.deviceIp,
      sessionId: ateSession.value.sessionId
    }))
  }

  /**
   * 手动强制 IO 输出（手动点检）
   * @param {object} options
   * @param {string} options.deviceIp - 设备 IP
   * @param {object} options.outputs - 输出配置 { channel: value }
   * @param {number} options.timeoutMs - 超时时间
   */
  function manualForceIo(options) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'manual_force_io_request',
      ...options
    }))
  }

  /**
   * 获取当前测试会话
   */
  function getTestSession() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!selectedDeviceIp.value) return
    ws.send(JSON.stringify({
      type: 'get_test_session',
      deviceIp: selectedDeviceIp.value
    }))
  }

  /**
   * 获取 ATE 历史报告列表
   */
  function fetchAteReports() {
    fetch('/api/test/reports')
      .then(res => res.json())
      .then(data => {
        ateReports.value = data.reports || []
      })
      .catch(err => {
        console.error('[Store] Fetch ATE reports error:', err)
      })
  }

  /**
   * 切换报文调试模式
   */
  function toggleDebugMode() {
    ateDebugMode.value = !ateDebugMode.value
    if (!ateDebugMode.value) {
      ateRawFrames.value = []
    }
  }

  /**
   * 清空 ATE 日志
   */
  function clearAteLogs() {
    ateLogs.value = []
  }

  /**
   * 清空 ATE 会话状态
   */
  function clearAteSession() {
    ateSession.value = null
    ateProgress.value = 0
    ateStatus.value = 'idle'
    ateCurrentItemId.value = null
    ateTimeline.value = {}
    ateSummary.value = { total: 0, passed: 0, failed: 0, skipped: 0 }
  }

  return {
    // 原有状态
    wsConnected, devices, tempData, humiData, co2Data, nh3Data, windData,
    relayStatus, digitalInputs, outdoorTemp, outdoorHumi, pressureData,
    otaProgress, otaStatus, lastUpdate, selectedDeviceIp, onlineDevices,
    connect, controlRelay, triggerOTA,

    // ATE 状态
    ateSession, ateProgress, ateStatus, ateCurrentItemId, ateTimeline,
    ateSummary, ateLogs, ateReports, ateRawFrames, ateDebugMode, ateDeviceConnected,

    // ATE 方法
    startTest, stopTest, resetTest, retryFailed, manualForceIo,
    getTestSession, fetchAteReports, toggleDebugMode, clearAteLogs, clearAteSession
  }
})
