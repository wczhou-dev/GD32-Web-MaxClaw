import { createRouter, createWebHistory } from 'vue-router'
import Monitor from './views/Monitor.vue'
import Relay from './views/Relay.vue'
import OTA from './views/OTA.vue'
import Device from './views/Device.vue'

const routes = [
  { path: '/', redirect: '/monitor' },
  { path: '/monitor', name: 'Monitor', component: Monitor },
  { path: '/relay', name: 'Relay', component: Relay },
  { path: '/ota', name: 'OTA', component: OTA },
  { path: '/device', name: 'Device', component: Device }
]

export default createRouter({
  history: createWebHistory(),
  routes
})
