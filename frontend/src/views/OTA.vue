<template>
  <div class="ota">
    <h2 class="page-title">📦 OTA远程升级</h2>

    <div class="ota-card">
      <div class="ota-status">
        <el-tag :type="otaTagType" size="large">{{ otaStatusText }}</el-tag>
        <span class="progress-text">{{ store.otaProgress }}%</span>
      </div>
      <el-progress :percentage="store.otaProgress" :color="otaProgressColor" style="margin: 20px 0;" />

      <el-form :inline="true" style="margin-top: 20px;">
        <el-form-item label="目标版本">
          <el-input-number v-model="targetVersion" :min="1" :max="9999" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :disabled="!store.wsConnected" @click="triggerOTA">
            触发升级
          </el-button>
        </el-form-item>
      </el-form>

      <el-divider />

      <el-upload ref="uploadRef" class="upload" drag action="/api/ota/upload" :auto-upload="false" :on-success="onUploadSuccess" :on-error="onUploadError" accept=".rbl">
        <el-icon><UploadFilled /></el-icon>
        <div>拖拽固件文件到此处或<em>点击上传</em></div>
        <template #tip>
          <div class="el-upload__tip">只能上传 .rbl 文件</div>
        </template>
      </el-upload>
      <el-button type="success" @click="uploadFirmware" style="margin-top: 10px;">上传固件</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useDeviceStore } from '../stores/deviceStore'
const store = useDeviceStore()
const targetVersion = ref(201)
const uploadRef = ref()

const otaStatusText = computed(() => ['空闲', '下载中', '校验中', '升级成功', '升级失败'][store.otaStatus] || '未知')
const otaTagType = computed(() => ['', 'primary', 'warning', 'success', 'danger'][store.otaStatus] || 'info')
const otaProgressColor = computed(() => {
  const colors = { 0: '#909399', 1: '#409eff', 2: '#e6a23c', 3: '#67c23a', 255: '#f56c6c' }
  return colors[store.otaStatus] || '#409eff'
})

function triggerOTA() {
  store.triggerOTA(targetVersion.value)
}

function uploadFirmware() {
  uploadRef.value?.submit()
}

function onUploadSuccess() { alert('上传成功') }
function onUploadError() { alert('上传失败') }
</script>

<style scoped>
.ota { color: #fff; }
.page-title { margin-bottom: 20px; font-size: 20px; }
.ota-card { background: #1a1a2e; border-radius: 10px; padding: 20px; }
.ota-status { display: flex; align-items: center; gap: 15px; }
.progress-text { font-size: 24px; font-weight: bold; color: #E94560; }
.upload { width: 100%; }
.upload .el-upload-dragger { background: #16213e; border: 1px dashed #444; }
</style>
