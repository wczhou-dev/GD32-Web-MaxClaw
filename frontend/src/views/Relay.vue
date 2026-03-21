<template>
  <div class="relay">
    <h2 class="page-title">🔌 继电器控制</h2>

    <div class="relay-table">
      <el-table :data="relayList" stripe style="width: 100%" :cell-style="{ background: '#1a1a2e', color: '#fff' }" :header-cell-style="{ background: '#16213e', color: '#fff' }">
        <el-table-column prop="index" label="编号" width="80" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.status ? 'success' : 'info'" size="large">
              {{ row.status ? 'ON' : 'OFF' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="control" label="控制">
          <template #default="{ row }">
            <el-popconfirm title="确认操作？" @confirm="toggleRelay(row.index, !row.status)">
              <template #reference>
                <el-switch v-model="row.status" :loading="row.loading" :disabled="!store.wsConnected" />
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useDeviceStore } from '../stores/deviceStore'
const store = useDeviceStore()

const relayList = computed(() => store.relayStatus.map((s, i) => ({ index: i + 1, status: s, loading: false })))

function toggleRelay(index, value) {
  store.controlRelay(index - 1, value)
}
</script>

<style scoped>
.relay { color: #fff; }
.page-title { margin-bottom: 20px; font-size: 20px; }
.relay-table { background: #1a1a2e; border-radius: 10px; padding: 15px; }
</style>
