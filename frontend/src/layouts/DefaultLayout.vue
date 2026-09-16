<template>
  <div class="flex min-h-screen flex-col bg-background text-foreground">
    <AppNavbar @open-login="openLoginDialog" />
    <main class="flex-1">
      <RouterView v-slot="{ Component }">
        <component
          :is="Component"
          v-if="$route.name === 'reset-password'"
          @open-login="openLoginDialog"
        />
        <component :is="Component" v-else />
      </RouterView>
    </main>
    <AppFooter />
    <LoginDialog :open="isLoginDialogOpen" @update:open="handleLoginDialogOpenChange" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppNavbar from '@/components/AppNavbar.vue'
import AppFooter from '@/components/AppFooter.vue'
import LoginDialog from '@/components/auth/LoginDialog.vue'
import { useUserStore } from '@/stores/user'

const isLoginDialogOpen = ref(false)
const loginDialogOpener = ref<HTMLElement | null>(null)
const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

function openLoginDialog(opener?: HTMLElement) {
  loginDialogOpener.value = opener ?? null
  isLoginDialogOpen.value = true
}

async function handleLoginDialogOpenChange(open: boolean) {
  isLoginDialogOpen.value = open
  if (open) return

  const opener = loginDialogOpener.value
  loginDialogOpener.value = null

  if (!userStore.currentUser && route.query.login === 'required') {
    const query = { ...route.query }
    delete query.login
    delete query.redirect
    await router.replace({ query })
  }

  if (!opener?.isConnected) return
  await nextTick()
  opener.focus()
}

watch(
  () => route.query.login,
  (loginReason) => {
    if (loginReason === 'required') {
      openLoginDialog()
    }
  },
  { immediate: true },
)

watch(
  () => userStore.currentUser,
  async (currentUser) => {
    if (!currentUser || route.query.login !== 'required') return

    const redirect = route.query.redirect
    const target =
      typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')
        ? redirect
        : '/'

    await router.replace(target)
  },
)
</script>
