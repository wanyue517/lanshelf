import { createApp } from 'vue'
import App from './App.vue'
import { installDesktopBridge } from './bridge'
import './style.css'

void installDesktopBridge().then(() => {
  createApp(App).mount('#app')
}).catch(error => {
  document.body.textContent = 'LanShelf 初始化失败：' + String(error)
})
