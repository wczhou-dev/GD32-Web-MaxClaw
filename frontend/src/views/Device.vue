<template>
  <div class="device">
    <h2 class="page-title">🖥️ 设备管理</h2>

    <div class="device-list">
      <el-table :data="store.devices" stripe style="width: 100%" :cell-style="{ background: '#1a1a2e', color: '#fff' }" :header-cell-style="{ background: '#16213e', color: '#fff' }">
        <el-table-column prop="name" label="设备名称" />
        <el-table-column prop="ip" label="IP地址" />
        <el-table-column prop="port" label="端口" width="100" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.status === 'CONNECTED' ? 'success' : 'danger'">
              {{ row.status === 'CONNECTED' ? '🟢 在线' : '🔴 离线' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button size="small" @click="reconnect(row)">重连</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { useDeviceStore } from '../stores/deviceStore'
const store = useDeviceStore()
function reconnect(row) { console.log('Reconnect:', row.ip) }
</script>

<style scoped>
.device { color: #fff; }
.page-title { margin-bottom: 20px; font-size: 20px; }
.device-list { background: #1a1a2e; border-radius: 10px; padding: 15px; }
</style>
