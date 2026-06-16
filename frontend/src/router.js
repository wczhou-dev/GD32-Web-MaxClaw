import { createRouter, createWebHistory } from 'vue-router'
import Monitor from './views/Monitor.vue'
import OTA from './views/OTA.vue'
import Device from './views/Device.vue'
import AteTest from './views/AteTest.vue'
import SensorTest from './views/SensorTest.vue'

const routes = [
  { path: '/', redirect: '/monitor' },
  { path: '/monitor', name: 'Monitor', component: Monitor },
  { path: '/ota', name: 'OTA', component: OTA },
  { path: '/device', name: 'Device', component: Device },
  { path: '/ate', name: 'AteTest', component: AteTest },
  { path: '/sensor-test', name: 'SensorTest', component: SensorTest }
]

export default createRouter({
  history: createWebHistory(),
  routes
})
