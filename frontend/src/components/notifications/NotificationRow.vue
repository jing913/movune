<script setup lang="ts">
import { UserRound } from '@lucide/vue'
import UserAvatar from '@/components/user/UserAvatar.vue'
import type { NotificationDto } from '@/services/notifications'

defineProps<{
  notification: NotificationDto
  selected?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  select: [notification: NotificationDto]
}>()

function relativeTime(value: string) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (elapsedSeconds < 60) return '剛剛'
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} 分鐘前`
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)} 小時前`
  if (elapsedSeconds < 604800) return `${Math.floor(elapsedSeconds / 86400)} 天前`
  return new Intl.DateTimeFormat('zh-TW', { month: 'short', day: 'numeric' }).format(
    new Date(value),
  )
}
</script>

<template>
  <component
    :is="notification.actor ? 'button' : 'div'"
    :type="notification.actor ? 'button' : undefined"
    class="group flex w-full min-w-0 items-start gap-3 border-l-2 px-3 text-left transition-colors focus-visible:outline-offset-[-2px]"
    :class="[
      compact ? 'py-3' : 'py-4 sm:px-4',
      selected ? 'border-l-accent-caramel bg-accent-caramel-soft' : 'border-l-transparent',
      notification.readAt
        ? 'text-muted-foreground hover:bg-surface-raised/70'
        : 'bg-surface-raised/45 text-foreground hover:bg-surface-raised',
      notification.actor ? 'cursor-pointer' : 'cursor-default',
    ]"
    :aria-label="
      notification.actor
        ? `${notification.actor.displayName || notification.actor.account} 開始關注你${notification.readAt ? '' : '，未讀'}`
        : undefined
    "
    @click="notification.actor && emit('select', notification)"
  >
    <UserAvatar
      v-if="notification.actor"
      class="shrink-0"
      :account="notification.actor.account"
      :user-id="notification.actor._id"
    />
    <span
      v-else
      class="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"
      aria-hidden="true"
    >
      <UserRound class="size-5" />
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-start">
        <span class="min-w-0 text-sm leading-5">
          <strong :class="notification.readAt ? 'font-medium text-foreground' : 'font-bold'">
            {{ notification.actor?.displayName || notification.actor?.account || '已停用的使用者' }}
          </strong>
          <span> 開始關注你</span>
        </span>
      </span>
      <span class="mt-1 block text-xs text-muted-foreground">
        <span>{{ relativeTime(notification.createdAt) }}</span>
      </span>
    </span>
    <span
      class="mt-2.5 size-2 shrink-0 rounded-full"
      :class="notification.readAt ? 'invisible' : 'bg-status-unread'"
      aria-hidden="true"
    ></span>
  </component>
</template>
