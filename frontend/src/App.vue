<!--
  App.vue: 整个前端应用的“总底盘” (Global Chassis)
  
  --- 架构类比说明（面向嵌入式开发者） ---
  1. <template> 结构  => 物理机箱布局 : 定义了 Header、Sidebar 和主显示区的位置。
  2. <router-view />  => 功能插槽 : 不同的页面（插卡）会根据路由指令插入到这个位置。
  3. onMounted        => 系统上电回调 : 初始化时钟、建立 WebSocket 连接。
  4. ref/computed     => 响应式寄存器 : 变量值改变时，UI 会通过“中断驱动”方式自动重绘。
  -----------------------------------------
-->

<template>
  <!-- Element Plus 全局配置：设置语言为中文 -->
  <el-config-provider :locale="zhCn">
    <div class="app-container">
      <!-- 顶部导航栏 (Header) -->
      <header class="header">
        <h1 class="title">🦞 GD32 环控系统</h1>
        <div class="device-status">
          <!-- 状态灯：根据连接状态显示绿色或红色 (类似 LED 状态灯) -->
          <el-tag :type="connectionStatus === 'connected' ? 'success' : 'danger'" size="large">
            {{ connectionStatus === 'connected' ? '🟢 已连接' : '🔴 未连接' }}
          </el-tag>
          <!-- 实时时间显示 -->
          <span class="time">{{ currentTime }}</span>
        </div>
      </header>

      <!-- 主布局区域 (Main Layout) -->
      <div class="main-layout">
        <!-- 左侧导航菜单 (Sidebar) -->
        <nav class="sidebar">
          <!-- router 属性开启后，index 路径会自动与路由系统关联 -->
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

        <!-- 主内容显示区 (Content) -->
        <main class="content">
          <!-- 核心插槽：路由匹配到的组件（如 Monitor.vue）会渲染在这里 -->
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

// 获取当前路由实例和全局设备状态库
const route = useRoute()
const deviceStore = useDeviceStore()

// 定义响应式变量 (类似 volatile 变量)
const currentTime = ref('')
let timer = null

// 计算属性：根据 Store 中的 wsConnected 自动计算连接状态字符串
const connectionStatus = computed(() => 
  deviceStore.wsConnected ? 'connected' : 'disconnected'
)

// 更新时间的函数
const updateTime = () => {
  const now = new Date()
  currentTime.value = now.toLocaleString('zh-CN')
}

/**
 * 生命周期钩子：组件挂载完成 (系统上电) 时执行
 */
onMounted(() => {
  updateTime()
  // 启动 1s 定时器用于更新显示时间 (类似硬件定时器)
  timer = setInterval(updateTime, 1000)
  // 启动全局 WebSocket 连接流程
  deviceStore.connect()
})

/**
 * 生命周期钩子：组件卸载 (关机/切换) 时执行
 */
onUnmounted(() => {
  // 清理定时器，防止内存泄漏
  if (timer) clearInterval(timer)
})
</script>

<style>
/* 全局基础样式清理 */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  background: #0f0f23; /* 深蓝色背景，符合工业风 */
  color: #fff;
}

/* App 容器：占据整个屏幕高度 */
.app-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* 顶部 Header 样式 */
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

/* 左右分栏布局样式 */
.main-layout {
  display: flex;
  flex: 1;
}

/* 侧边栏样式 */
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

/* 悬停及激活状态的强调色 */
.sidebar .el-menu-item:hover,
.sidebar .el-menu-item.is-active {
  background: rgba(233, 69, 96, 0.2);
  color: #E94560; /* 主题红 */
}

/* 内容显示区：自动填满剩余空间并支持滚动 */
.content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}
</style>
