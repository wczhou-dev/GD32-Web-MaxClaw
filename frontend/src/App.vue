<template>
  <el-config-provider :locale="zhCn">
    <div class="app-container">
      <!-- 顶部导航 -->
      <header class="header">
        <h1 class="title">🦞 GD32 环控系统</h1>
        <div class="device-status">
          <el-tag :type="connectionStatus === 'connected' ? 'success' : 'danger'" size="large">
            {{ connectionStatus === 'connected' ? '🟢 已连接' : '🔴 未连接' }}
          </el-tag>
          <span class="time">{{ currentTime }}</span>
        </div>
      </header>

      <!-- 侧边导航 -->
      <div class="main-layout">
        <nav class="sidebar">
          <el-menu :default-active="route.path" router>
            <el-menu-item index="/monitor">
              <el-icon><Monitor /></el-icon>
              <span>环境监控</span>
            </el-menu-item>
            <el-menu-item index="/relay">
              <el-icon><Switch /></el-icon>
              <span>继电器控制</span>
            </el-menu-item>
            <el-menu-item index="/ota">
              <el-icon><Upload /></el-icon>
              <span>OTA升级</span>
            </el-menu-item>
            <el-menu-item index="/device">
              <el-icon><Setting /></el-icon>
              <span>设备管理</span>
            </el-menu-item>
          </el-menu>
        </nav>

        <!-- 主内容区 -->
        <main class="content">
          <router-view />
        </main>
      </div>
    </div>
  </el-config-provider>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useDeviceStore } from './stores/deviceStore'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'

const route = useRoute()
const deviceStore = useDeviceStore()

const currentTime = ref('')
let timer = null

const connectionStatus = computed(() => 
  deviceStore.wsConnected ? 'connected' : 'disconnected'
)

const updateTime = () => {
  const now = new Date()
  currentTime.value = now.toLocaleString('zh-CN')
}

onMounted(() => {
  updateTime()
  timer = setInterval(updateTime, 1000)
  deviceStore.connect()
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  background: #0f0f23;
  color: #fff;
}

.app-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.header {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  padding: 15px 30px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #333;
}

.title {
  font-size: 20px;
  color: #fff;
}

.device-status {
  display: flex;
  align-items: center;
  gap: 15px;
}

.time {
  color: #888;
  font-size: 14px;
}

.main-layout {
  display: flex;
  flex: 1;
}

.sidebar {
  width: 200px;
  background: #1a1a2e;
  padding: 20px 0;
}

.sidebar .el-menu {
  background: transparent;
  border: none;
}

.sidebar .el-menu-item {
  color: #aaa;
  height: 50px;
  line-height: 50px;
}

.sidebar .el-menu-item:hover,
.sidebar .el-menu-item.is-active {
  background: rgba(233, 69, 96, 0.2);
  color: #E94560;
}

.content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}
</style>
