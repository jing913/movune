import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from '@/router'
import { createPinia } from 'pinia'
import { useUserStore } from '@/stores/user'
import { PiniaColada } from '@pinia/colada'

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.use(PiniaColada)
app.use(router)

const userStore = useUserStore()

void userStore.restoreAuth()

app.mount('#app')
