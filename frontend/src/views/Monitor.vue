<template>
  <div class="monitor">
    <h2 class="page-title">🌡️ 环境监控</h2>

    <!-- 设备选择 -->
    <div class="device-selector">
      <el-select v-model="selectedDevice" placeholder="选择设备" style="width: 200px;">
        <el-option label="1号舍 192.168.110.125" value="192.168.110.125" />
      </el-select>
      <span class="last-update">最后更新: {{ store.lastUpdate?.toLocaleTimeString() || '--:--:--' }}</span>
    </div>

    <!-- 温湿度 -->
    <div class="section">
      <h3>📊 舍内温湿度 (1#-16#)</h3>
      <div class="card-grid">
        <div v-for="i in 16" :key="'th'+i" class="data-card">
          <div class="card-label">{{ i }}#</div>
          <div class="card-value temp">{{ store.tempData[i-1] ?? '--' }}<span class="unit">°C</span></div>
          <div class="card-value humi">{{ store.humiData[i-1] ?? '--' }}<span class="unit">%</span></div>
        </div>
      </div>
    </div>

    <!-- CO2/氨气/风速 -->
    <div class="section">
      <div class="row">
        <div class="col">
          <h3>🌬️ CO2 (1#-8#)</h3>
          <div class="card-grid small">
            <div v-for="i in 8" :key="'co2'+i" class="data-card small">
              <div class="card-label">{{ i }}#</div>
              <div class="card-value">{{ store.co2Data[i-1] ?? '--' }}<span class="unit">ppm</span></div>
            </div>
          </div>
        </div>
        <div class="col">
          <h3>💨 氨气 (1#-4#)</h3>
          <div class="card-grid small">
            <div v-for="i in 4" :key="'nh3'+i" class="data-card small">
              <div class="card-label">{{ i }}#</div>
              <div class="card-value">{{ store.nh3Data[i-1] ?? '--' }}<span class="unit">ppm</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="section" style="margin-top:20px;">
        <h3>💨 风速 (1#-12#)</h3>
        <div class="card-grid medium">
          <div v-for="i in 12" :key="'wind'+i" class="data-card medium">
            <div class="card-label">{{ i }}#</div>
            <div class="card-value">{{ store.windData[i-1] ?? '--' }}<span class="unit">m/s</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 舍外/压差 -->
    <div class="section">
      <h3>🏠 舍外环境</h3>
      <div class="card-row">
        <div class="data-card">
          <div class="card-label">舍外温度</div>
          <div class="card-value">{{ store.outdoorTemp ?? '--' }}<span class="unit">°C</span></div>
        </div>
        <div class="data-card">
          <div class="card-label">舍外湿度</div>
          <div class="card-value">{{ store.outdoorHumi ?? '--' }}<span class="unit">%</span></div>
        </div>
        <div v-for="i in 4" :key="'p'+i" class="data-card">
          <div class="card-label">{{ i }}#压差</div>
          <div class="card-value">{{ store.pressureData[i-1] ?? '--' }}<span class="unit">Pa</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useDeviceStore } from '../stores/deviceStore'
const store = useDeviceStore()
const selectedDevice = ref('192.168.110.125')
</script>

<style scoped>
.monitor { color: #fff; }
.page-title { margin-bottom: 20px; font-size: 20px; }
.device-selector { display: flex; align-items: center; gap: 20px; margin-bottom: 20px; }
.last-update { color: #888; font-size: 12px; }
.section { background: #1a1a2e; border-radius: 10px; padding: 15px; margin-bottom: 15px; }
.section h3 { margin-bottom: 12px; color: #E94560; font-size: 14px; }
.card-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.card-grid.small, .card-grid.medium { gap: 8px; }
.data-card { background: linear-gradient(135deg, #16213e, #1a1a2e); border: 1px solid #333; border-radius: 8px; padding: 10px 15px; text-align: center; min-width: 70px; }
.data-card.small, .data-card.medium { min-width: 55px; padding: 8px; }
.card-label { font-size: 10px; color: #888; margin-bottom: 5px; }
.card-value { font-size: 18px; font-weight: bold; color: #fff; }
.card-value.temp { color: #ff6b6b; }
.card-value.humi { color: #4ecdc4; font-size: 14px; margin-top: 3px; }
.unit { font-size: 10px; color: #888; margin-left: 2px; }
.row { display: flex; gap: 20px; }
.col { flex: 1; }
.card-row { display: flex; gap: 15px; flex-wrap: wrap; }
</style>
