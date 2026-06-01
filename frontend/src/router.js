import { createRouter, createWebHistory } from 'vue-router'
import Monitor from './views/Monitor.vue'
import OTA from './views/OTA.vue'
import Device from './views/Device.vue'
import AteTest from './views/AteTest.vue'

const routes = [
  { path: '/', redirect: '/monitor' },
  { path: '/monitor', name: 'Monitor', component: Monitor },
  { path: '/ota', name: 'OTA', component: OTA },
  { path: '/device', name: 'Device', component: Device },
  { path: '/ate', name: 'AteTest', component: AteTest }
]

export default createRouter({
  history: createWebHistory(),
  routes
})
