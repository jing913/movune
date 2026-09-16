<template>
  <Avatar :class="props.size === 'large' ? 'size-20 sm:size-28 lg:size-32' : 'size-10'">
    <AvatarImage :src="avatarUrl" alt="" />
    <AvatarFallback>
      {{ props.account.charAt(0) }}
    </AvatarFallback>
  </Avatar>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'

const props = defineProps<{
  userId: string
  account: string
  size?: 'default' | 'large'
}>()

const avatarUrl = computed(() => {
  // 根據 props.userId 產生 DiceBear URL
  return `https://api.dicebear.com/10.x/notionists/svg?seed=${encodeURIComponent(props.userId)}&backgroundColor=e3d2b4&inkColor=4a3526&paperColor=f5ead6`
})
</script>
