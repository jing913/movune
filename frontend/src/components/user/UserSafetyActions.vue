<script setup lang="ts">
import { MoreHorizontal } from '@lucide/vue'
import { ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  blockUser,
  reportConversation,
  reportProfile,
  unblockUser,
  type ContactInteraction,
  type ReportReason,
} from '@/services/safety'

const props = withDefaults(
  defineProps<{
    userId: string
    displayName: string
    conversationId?: string
    canBlock?: boolean
    canUnblock?: boolean
    canReport?: boolean
  }>(),
  {
    conversationId: undefined,
    canBlock: true,
    canUnblock: false,
    canReport: true,
  },
)

const emit = defineEmits<{
  interactionChanged: [interaction: ContactInteraction]
  mutationPending: [pending: boolean]
}>()

const blockOpen = ref(false)
const reportOpen = ref(false)
const feedbackOpen = ref(false)
const blockPending = ref(false)
const unblockPending = ref(false)
const reportPending = ref(false)
const localCanBlock = ref(props.canBlock)
const localCanUnblock = ref(props.canUnblock)
const localCanReport = ref(props.canReport)
const blockError = ref('')
const feedbackError = ref('')
const reportError = ref('')
const reportReceived = ref(false)
const reportReason = ref<ReportReason | ''>('')
const reportDescription = ref('')
const liveStatus = ref('')

watch(
  () => [props.canBlock, props.canUnblock, props.canReport] as const,
  ([canBlock, canUnblock, canReport]) => {
    localCanBlock.value = canBlock
    localCanUnblock.value = canUnblock
    localCanReport.value = canReport
  },
)

function installInteraction(interaction: ContactInteraction) {
  localCanBlock.value = interaction.capabilities.canBlockUser
  localCanUnblock.value = interaction.capabilities.canUnblockUser
  localCanReport.value = interaction.capabilities.canReportUser
  emit('interactionChanged', interaction)
}

function openBlockConfirmation() {
  blockError.value = ''
  blockOpen.value = true
}

async function confirmBlock() {
  if (blockPending.value) return
  blockPending.value = true
  emit('mutationPending', true)
  blockError.value = ''
  try {
    const interaction = await blockUser(props.userId)
    installInteraction(interaction)
    blockOpen.value = false
    liveStatus.value = `已封鎖 ${props.displayName}。`
  } catch {
    blockError.value = '目前無法封鎖這位使用者，請稍後再試。'
  } finally {
    blockPending.value = false
    emit('mutationPending', false)
  }
}

async function performUnblock() {
  if (unblockPending.value) return
  unblockPending.value = true
  emit('mutationPending', true)
  feedbackError.value = ''
  try {
    const interaction = await unblockUser(props.userId)
    installInteraction(interaction)
    liveStatus.value = `已解除封鎖 ${props.displayName}。先前的追蹤與傳訊權限不會自動恢復。`
  } catch {
    feedbackError.value = '目前無法解除封鎖，請稍後再試。'
    feedbackOpen.value = true
  } finally {
    unblockPending.value = false
    emit('mutationPending', false)
  }
}

function openReport() {
  reportError.value = ''
  reportReceived.value = false
  reportReason.value = ''
  reportDescription.value = ''
  reportOpen.value = true
}

function handleReportOpenChange(open: boolean) {
  if (reportPending.value) return
  reportOpen.value = open
}

async function submitReport() {
  if (!reportReason.value || reportPending.value) return
  reportPending.value = true
  reportError.value = ''
  const description = reportDescription.value.trim()
  const input = {
    reason: reportReason.value,
    ...(description ? { description } : {}),
  }
  try {
    if (props.conversationId) await reportConversation(props.conversationId, input)
    else await reportProfile(props.userId, input)
    reportReceived.value = true
    liveStatus.value = '檢舉已收到。'
  } catch {
    reportError.value = '目前無法送出檢舉，請稍後再試。'
  } finally {
    reportPending.value = false
  }
}
</script>

<template>
  <div class="inline-flex shrink-0">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          :aria-label="
            localCanUnblock
              ? `${displayName} 的更多安全選項，目前已封鎖`
              : `${displayName} 的更多安全選項`
          "
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-52">
        <slot name="before" />
        <DropdownMenuItem
          v-if="localCanBlock"
          variant="destructive"
          class="min-h-10"
          @select="openBlockConfirmation"
        >
          封鎖
        </DropdownMenuItem>
        <DropdownMenuItem
          v-if="localCanUnblock"
          class="min-h-10"
          :disabled="unblockPending"
          @select="performUnblock"
        >
          {{ unblockPending ? '解除封鎖中…' : '解除封鎖' }}
        </DropdownMenuItem>
        <DropdownMenuItem v-if="localCanReport" class="min-h-10" @select="openReport">
          檢舉
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <p class="sr-only" role="status" aria-live="polite">{{ liveStatus }}</p>

    <Dialog :open="blockOpen" @update:open="blockOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>封鎖這位使用者？</DialogTitle>
          <DialogDescription>
            封鎖
            {{ displayName }}
            會結束目前的互動與傳訊權限。過去的訊息仍會保留；解除封鎖後，先前的追蹤與傳訊權限也不會自動恢復。
          </DialogDescription>
        </DialogHeader>
        <p v-if="blockError" class="text-sm font-medium text-destructive" role="alert">
          {{ blockError }}
        </p>
        <DialogFooter>
          <button
            type="button"
            class="min-h-11 rounded-md border border-control px-5 font-semibold"
            :disabled="blockPending"
            @click="blockOpen = false"
          >
            取消
          </button>
          <button
            type="button"
            class="min-h-11 rounded-md bg-destructive px-5 font-semibold text-white disabled:cursor-wait disabled:opacity-60"
            :disabled="blockPending"
            :aria-busy="blockPending"
            @click="confirmBlock"
          >
            {{ blockPending ? '封鎖中…' : '封鎖' }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="reportOpen" @update:open="handleReportOpenChange">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>檢舉 {{ displayName }}</DialogTitle>
          <DialogDescription> 請選擇最符合的原因。送出後僅代表我們已收到檢舉。 </DialogDescription>
        </DialogHeader>
        <div v-if="reportReceived" class="space-y-4">
          <p class="text-sm font-medium" role="status">檢舉已收到。</p>
          <DialogFooter>
            <button
              type="button"
              class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground"
              @click="reportOpen = false"
            >
              完成
            </button>
          </DialogFooter>
        </div>
        <form v-else class="space-y-4" @submit.prevent="submitReport">
          <div>
            <label for="safety-report-reason" class="mb-1.5 block text-sm font-semibold">
              檢舉原因
            </label>
            <select
              id="safety-report-reason"
              v-model="reportReason"
              required
              class="min-h-11 w-full rounded-md border border-control bg-background px-3"
            >
              <option value="" disabled>請選擇原因</option>
              <option value="harassment_or_uncomfortable">騷擾或令人不適</option>
              <option value="spam_or_suspicious">垃圾訊息或可疑行為</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div>
            <label for="safety-report-description" class="mb-1.5 block text-sm font-semibold">
              補充說明（選填）
            </label>
            <textarea
              id="safety-report-description"
              v-model="reportDescription"
              maxlength="1000"
              rows="4"
              class="w-full resize-y rounded-md border border-control bg-background px-3 py-2"
            ></textarea>
          </div>
          <p v-if="reportError" class="text-sm font-medium text-destructive" role="alert">
            {{ reportError }}
          </p>
          <DialogFooter>
            <button
              type="button"
              class="min-h-11 rounded-md border border-control px-5 font-semibold"
              :disabled="reportPending"
              @click="reportOpen = false"
            >
              取消
            </button>
            <button
              type="submit"
              class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
              :disabled="!reportReason || reportPending"
              :aria-busy="reportPending"
            >
              {{ reportPending ? '送出中…' : '送出檢舉' }}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="feedbackOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>無法更新封鎖狀態</DialogTitle>
          <DialogDescription>{{ feedbackError }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            class="min-h-11 rounded-md border border-control px-5 font-semibold"
            @click="feedbackOpen = false"
          >
            關閉
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
