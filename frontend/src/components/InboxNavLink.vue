<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { Mail } from '@lucide/vue'
import { useInboxSummary } from '@/composables/useInboxSummary'
import { useUserStore } from '@/stores/user'
import { connectRealtime, onRealtime, onRealtimeConnect } from '@/services/realtime'
import { inboxLinkLabel } from '@/services/directReadModel'

const userStore = useUserStore()
const { summary, refresh } = useInboxSummary()
let timer: number | undefined
let cleanups: (() => void)[] = []
onMounted(() => {
  void refresh().catch(() => {})
  timer = window.setInterval(() => void refresh().catch(() => {}), 60_000)
  if (userStore.accessToken && userStore.currentUser) {
    connectRealtime(userStore.accessToken, userStore.currentUser._id)
    cleanups = [
      onRealtimeConnect(() => void refresh().catch(() => {})),
      onRealtime('message.created', () => void refresh().catch(() => {})),
      onRealtime('direct.updated', () => void refresh().catch(() => {})),
      onRealtime('notification.created', () => void refresh().catch(() => {})),
      onRealtime('read.updated', () => void refresh().catch(() => {})),
      onRealtime('discussion.membership.updated', () => void refresh().catch(() => {})),
    ]
  }
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  cleanups.forEach((cleanup) => cleanup())
})
</script>

<template>
  <RouterLink
    to="/inbox"
    class="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-surface-raised"
    :aria-label="inboxLinkLabel(summary.inboxNeedsAttention)"
  >
    <Mail class="size-5" aria-hidden="true" />
    <span
      v-if="summary.inboxNeedsAttention"
      class="absolute right-2 top-2 size-2 rounded-full bg-accent-caramel"
      aria-hidden="true"
    />
  </RouterLink>
</template>
