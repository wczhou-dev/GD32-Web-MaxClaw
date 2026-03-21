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
  let ws = null
  const onlineDevices = computed(() => devices.value.filter(d => d.status === 'CONNECTED'))

  function connect() {
    if (ws) return
    ws = new WebSocket(`ws://${window.location.hostname}:3000`)
    ws.onopen = () => { wsConnected.value = true }
    ws.onclose = () => { wsConnected.value = false; ws = null; setTimeout(connect, 5000) }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'sensor_data') {
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
  }

  function controlRelay(relayIndex, value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'relay_control', relayIndex, value, deviceIp: '192.168.10.199' }))
  }

  function triggerOTA(version) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'ota_start', version, deviceIp: '192.168.10.199' }))
  }

  return { wsConnected, devices, tempData, humiData, co2Data, nh3Data, windData, relayStatus, digitalInputs, outdoorTemp, outdoorHumi, pressureData, otaProgress, otaStatus, lastUpdate, onlineDevices, connect, controlRelay, triggerOTA }
})
