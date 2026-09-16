<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useQueryCache } from '@pinia/colada'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCollections } from '@/composables/useCollections'
import {
  addCollectionMembership,
  createCollection,
  getCollectionErrorMessage,
  getMovieCollectionMemberships,
  removeCollectionMembership,
  type OwnerCollectionSummary,
  type CollectionVisibility,
} from '@/services/collections'
import { useUserStore } from '@/stores/user'

type MembershipOperation = {
  collectionId: string
  action: 'add' | 'remove'
}

type MembershipUndoRecord = {
  tmdbId: number
  addedCollectionIds: string[]
  removedCollectionIds: string[]
}

const UNDO_LIFETIME_MS = 10_000

const props = defineProps<{
  open: boolean
  tmdbId: number
  movieTitle: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const userStore = useUserStore()
const queryCache = useQueryCache()
const { collectionsQuery } = useCollections()
const initialMembershipSet = ref<Set<string>>(new Set())
const draftMembershipSet = ref<Set<string>>(new Set())
const committedMembershipSet = ref<Set<string>>(new Set())
const collectionsLoading = ref(false)
const membershipLoading = ref(false)
const collectionLoadError = ref('')
const membershipLoadError = ref('')
const saving = ref(false)
const saveError = ref('')
const quickCreateOpen = ref(false)
const quickCreateName = ref('')
const quickCreateVisibility = ref<CollectionVisibility>('private')
const quickCreateSaving = ref(false)
const quickCreateError = ref('')
const quickCreateMessage = ref('')
const quickCreatedCollections = ref<OwnerCollectionSummary[]>([])
const undoRecord = ref<MembershipUndoRecord | null>(null)
const undoBusy = ref(false)
const membershipStatus = ref('')
const membershipStatusIsError = ref(false)
let loadVersion = 0
let undoTimer: ReturnType<typeof setTimeout> | undefined

const collections = computed(() => {
  const quickCreatedIds = new Set(quickCreatedCollections.value.map((collection) => collection._id))
  return [
    ...quickCreatedCollections.value,
    ...(collectionsQuery.data.value ?? []).filter(
      (collection) => !quickCreatedIds.has(collection._id),
    ),
  ]
})
const ready = computed(
  () =>
    !collectionsLoading.value &&
    !membershipLoading.value &&
    !collectionLoadError.value &&
    !membershipLoadError.value,
)
const toAdd = computed(() =>
  [...draftMembershipSet.value].filter((id) => !initialMembershipSet.value.has(id)),
)
const toRemove = computed(() =>
  [...initialMembershipSet.value].filter((id) => !draftMembershipSet.value.has(id)),
)
const hasChanges = computed(() => toAdd.value.length > 0 || toRemove.value.length > 0)

function replaceMembershipState(collectionIds: string[]) {
  const authoritative = new Set(collectionIds)
  initialMembershipSet.value = new Set(authoritative)
  draftMembershipSet.value = new Set(authoritative)
  committedMembershipSet.value = new Set(authoritative)
}

function clearUndoTimer() {
  if (undoTimer === undefined) return
  clearTimeout(undoTimer)
  undoTimer = undefined
}

function clearUndoStatus() {
  clearUndoTimer()
  undoRecord.value = null
  membershipStatus.value = ''
  membershipStatusIsError.value = false
}

function showTemporaryStatus(message: string, isError = false) {
  clearUndoTimer()
  membershipStatus.value = message
  membershipStatusIsError.value = isError
  undoTimer = setTimeout(() => {
    membershipStatus.value = ''
    membershipStatusIsError.value = false
    undoTimer = undefined
  }, UNDO_LIFETIME_MS)
}

function offerUndo(record: MembershipUndoRecord) {
  clearUndoTimer()
  undoRecord.value = record
  membershipStatus.value = '收藏清單已更新'
  membershipStatusIsError.value = false
  undoTimer = setTimeout(() => {
    undoRecord.value = null
    membershipStatus.value = ''
    undoTimer = undefined
  }, UNDO_LIFETIME_MS)
}

async function refreshCollectionSummaries() {
  await queryCache.invalidateQueries({
    key: ['collections', userStore.currentUser?._id ?? 'anonymous'],
  })
}

async function loadPicker() {
  const version = ++loadVersion
  collectionsLoading.value = true
  membershipLoading.value = true
  collectionLoadError.value = ''
  membershipLoadError.value = ''
  saveError.value = ''
  quickCreateError.value = ''
  quickCreateMessage.value = ''

  const [collectionsResult, membershipResult] = await Promise.allSettled([
    collectionsQuery.refresh(),
    getMovieCollectionMemberships(props.tmdbId),
  ])
  if (version !== loadVersion || !props.open) return

  collectionsLoading.value = false
  membershipLoading.value = false
  if (collectionsResult.status === 'rejected' || collectionsQuery.error.value) {
    collectionLoadError.value = '收藏清單目前無法載入。'
  } else {
    const loadedIds = new Set(
      (collectionsQuery.data.value ?? []).map((collection) => collection._id),
    )
    quickCreatedCollections.value = quickCreatedCollections.value.filter(
      (collection) => !loadedIds.has(collection._id),
    )
  }
  if (membershipResult.status === 'rejected') {
    membershipLoadError.value = '目前無法確認這部電影的收藏清單歸屬。'
    return
  }
  replaceMembershipState(membershipResult.value.collectionIds)
}

function handleOpenChange(open: boolean) {
  if (!open && (saving.value || quickCreateSaving.value)) return
  emit('update:open', open)
}

function toggleCollection(collectionId: string) {
  if (!ready.value || saving.value) return
  const next = new Set(draftMembershipSet.value)
  if (next.has(collectionId)) next.delete(collectionId)
  else next.add(collectionId)
  draftMembershipSet.value = next
  saveError.value = ''
}

async function reconcileMemberships() {
  membershipLoading.value = true
  membershipLoadError.value = ''
  try {
    const lookup = await getMovieCollectionMemberships(props.tmdbId)
    replaceMembershipState(lookup.collectionIds)
    return true
  } catch {
    membershipLoadError.value = '變更後無法重新確認收藏清單歸屬，請再試一次。'
    return false
  } finally {
    membershipLoading.value = false
  }
}

async function saveMemberships() {
  if (!ready.value || !hasChanges.value || saving.value) return
  saving.value = true
  saveError.value = ''

  const operations: MembershipOperation[] = [
    ...toAdd.value.map((collectionId) => ({ collectionId, action: 'add' as const })),
    ...toRemove.value.map((collectionId) => ({ collectionId, action: 'remove' as const })),
  ]
  clearUndoStatus()
  const results = await Promise.allSettled(
    operations.map((operation) =>
      operation.action === 'add'
        ? addCollectionMembership(operation.collectionId, props.tmdbId)
        : removeCollectionMembership(operation.collectionId, props.tmdbId),
    ),
  )
  const successfulOperations = operations.filter(
    (_, index) => results[index]?.status === 'fulfilled',
  )
  const failedOperations = operations.filter((_, index) => results[index]?.status === 'rejected')

  let summaryRefreshFailed = false
  if (successfulOperations.length > 0) {
    try {
      await refreshCollectionSummaries()
    } catch {
      summaryRefreshFailed = true
    }
  }
  const reconciled = await reconcileMemberships()
  saving.value = false

  if (!reconciled) return
  if (failedOperations.length > 0) {
    saveError.value = `有 ${failedOperations.length} 項變更未完成，已依目前結果更新。請再試一次。`
    return
  }
  if (summaryRefreshFailed) {
    saveError.value = '歸屬已更新，但收藏清單摘要目前無法重新載入。'
    return
  }
  offerUndo({
    tmdbId: props.tmdbId,
    addedCollectionIds: operations
      .filter((operation) => operation.action === 'add')
      .map((operation) => operation.collectionId),
    removedCollectionIds: operations
      .filter((operation) => operation.action === 'remove')
      .map((operation) => operation.collectionId),
  })
  emit('update:open', false)
}

async function undoLastSave() {
  const record = undoRecord.value
  if (!record || undoBusy.value) return

  clearUndoTimer()
  undoBusy.value = true
  membershipStatus.value = '正在復原收藏清單變更…'
  membershipStatusIsError.value = false

  const inverseOperations: MembershipOperation[] = [
    ...record.addedCollectionIds.map((collectionId) => ({
      collectionId,
      action: 'remove' as const,
    })),
    ...record.removedCollectionIds.map((collectionId) => ({
      collectionId,
      action: 'add' as const,
    })),
  ]
  const results = await Promise.allSettled(
    inverseOperations.map((operation) =>
      operation.action === 'add'
        ? addCollectionMembership(operation.collectionId, record.tmdbId)
        : removeCollectionMembership(operation.collectionId, record.tmdbId),
    ),
  )
  const successfulOperations = inverseOperations.filter(
    (_, index) => results[index]?.status === 'fulfilled',
  )
  const hasFailedOperation = results.some((result) => result.status === 'rejected')

  let summaryRefreshFailed = false
  if (successfulOperations.length > 0) {
    try {
      await refreshCollectionSummaries()
    } catch {
      summaryRefreshFailed = true
    }
  }

  let reconciled: boolean
  try {
    const lookup = await getMovieCollectionMemberships(record.tmdbId)
    if (props.tmdbId === record.tmdbId) replaceMembershipState(lookup.collectionIds)
    reconciled = true
  } catch {
    reconciled = false
  }

  undoRecord.value = null
  undoBusy.value = false

  if (!reconciled) {
    showTemporaryStatus('復原後無法確認目前收藏清單狀態，請重新開啟清單再試。', true)
    return
  }
  if (hasFailedOperation) {
    showTemporaryStatus('部分變更無法復原，已同步目前狀態。', true)
    return
  }
  if (summaryRefreshFailed) {
    showTemporaryStatus('變更已復原，但收藏清單摘要目前無法重新載入。', true)
    return
  }
  showTemporaryStatus('已復原收藏清單變更')
}

function cancelPicker() {
  if (saving.value || quickCreateSaving.value) return
  draftMembershipSet.value = new Set(committedMembershipSet.value)
  emit('update:open', false)
}

async function quickCreate() {
  if (quickCreateSaving.value) return
  const name = quickCreateName.value.trim()
  if (!name) {
    quickCreateError.value = '請輸入收藏清單名稱。'
    return
  }

  quickCreateSaving.value = true
  quickCreateError.value = ''
  quickCreateMessage.value = ''
  const draftBeforeCreate = new Set(draftMembershipSet.value)
  try {
    const collection = await createCollection({ name, visibility: quickCreateVisibility.value })
    quickCreatedCollections.value = [
      {
        _id: collection._id,
        name: collection.name,
        ...(collection.description !== undefined ? { description: collection.description } : {}),
        visibility: collection.visibility,
        movieCount: 0,
        previewMovies: [],
      },
      ...quickCreatedCollections.value,
    ]
    draftMembershipSet.value = new Set([...draftBeforeCreate, collection._id])
    quickCreateName.value = ''
    quickCreateVisibility.value = 'private'
    quickCreateOpen.value = false
    quickCreateMessage.value = `已建立「${collection.name}」並選取；儲存後才會加入這部電影。`
    void queryCache
      .invalidateQueries({
        key: ['collections', userStore.currentUser?._id ?? 'anonymous'],
      })
      .catch(() => {})
  } catch (error) {
    quickCreateError.value = getCollectionErrorMessage(error, '收藏清單無法建立，請稍後再試。')
  } finally {
    quickCreateSaving.value = false
  }
}

watch(
  () => [props.open, props.tmdbId] as const,
  ([open]) => {
    if (!open) return
    quickCreateOpen.value = false
    quickCreateName.value = ''
    quickCreateVisibility.value = 'private'
    void loadPicker()
  },
)

onBeforeUnmount(clearUndoTimer)
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent
      class="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col gap-0 overflow-hidden p-0"
    >
      <DialogHeader class="shrink-0 px-5 pb-4 pt-6 text-left sm:px-6">
        <DialogTitle>管理收藏清單</DialogTitle>
        <DialogDescription>選擇《{{ movieTitle }}》要歸入的收藏清單。</DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-2 sm:px-6">
        <div
          v-if="collectionsLoading || membershipLoading"
          class="space-y-2 rounded-md bg-secondary p-5 text-sm text-muted-foreground"
          role="status"
        >
          <p v-if="collectionsLoading">正在載入收藏清單…</p>
          <p v-if="membershipLoading">正在確認目前歸屬…</p>
        </div>

        <div
          v-else-if="collectionLoadError || membershipLoadError"
          class="rounded-md bg-secondary p-5 text-sm"
          role="alert"
        >
          <p>{{ collectionLoadError || membershipLoadError }}</p>
          <button
            type="button"
            class="mt-3 min-h-11 rounded-md font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            @click="loadPicker"
          >
            再試一次
          </button>
        </div>

        <div v-else-if="collections.length === 0" class="rounded-md bg-secondary p-5">
          <p class="font-semibold">你還沒有收藏清單</p>
          <p class="mt-1 text-sm leading-6 text-muted-foreground">
            建立一個收藏清單，開始整理這部電影。
          </p>
        </div>

        <fieldset v-else class="space-y-2" :disabled="saving">
          <legend class="sr-only">選擇收藏清單</legend>
          <label
            v-for="collection in collections"
            :key="collection._id"
            class="flex min-h-14 cursor-pointer items-center gap-3 rounded-md border border-control px-4 py-2 transition hover:bg-secondary focus-within:ring-2 focus-within:ring-focus-ring"
            :class="
              draftMembershipSet.has(collection._id)
                ? 'border-accent-caramel bg-accent-caramel-soft'
                : ''
            "
          >
            <input
              type="checkbox"
              :checked="draftMembershipSet.has(collection._id)"
              :value="collection._id"
              class="size-4 shrink-0 accent-accent-caramel"
              @change="toggleCollection(collection._id)"
            />
            <span class="min-w-0 flex-1">
              <strong class="block break-words">{{ collection.name }}</strong>
              <small class="text-muted-foreground">
                {{ collection.visibility === 'public' ? '公開' : '私人' }} ·
                {{ collection.movieCount }} 部電影
              </small>
            </span>
          </label>
        </fieldset>

        <div class="mt-4 border-t border-border pt-4">
          <button
            v-if="!quickCreateOpen"
            type="button"
            class="min-h-11 rounded-md border border-control px-4 font-semibold transition hover:border-accent-caramel hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            :disabled="saving"
            @click="quickCreateOpen = true"
          >
            建立收藏清單
          </button>
          <form
            v-else
            class="grid gap-3 rounded-md bg-secondary/60 p-4"
            @submit.prevent="quickCreate"
          >
            <label class="grid gap-1.5 text-sm font-semibold">
              清單名稱
              <input
                v-model="quickCreateName"
                type="text"
                required
                autofocus
                class="min-h-11 min-w-0 rounded-md border border-control bg-card px-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                :disabled="quickCreateSaving"
              />
            </label>
            <fieldset class="flex flex-wrap gap-x-5 gap-y-2 text-sm" :disabled="quickCreateSaving">
              <legend class="mb-1 font-semibold">誰可以看到</legend>
              <label class="flex min-h-11 cursor-pointer items-center gap-2">
                <input v-model="quickCreateVisibility" type="radio" value="private" />
                私人
              </label>
              <label class="flex min-h-11 cursor-pointer items-center gap-2">
                <input v-model="quickCreateVisibility" type="radio" value="public" />
                公開
              </label>
            </fieldset>
            <p v-if="quickCreateError" class="text-sm text-destructive" role="alert">
              {{ quickCreateError }}
            </p>
            <div class="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                class="min-h-11 rounded-md px-4 font-semibold"
                :disabled="quickCreateSaving"
                @click="quickCreateOpen = false"
              >
                取消建立
              </button>
              <button
                type="submit"
                class="min-h-11 rounded-md bg-primary-cta px-4 font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
                :disabled="quickCreateSaving"
                :aria-busy="quickCreateSaving"
              >
                {{ quickCreateSaving ? '建立中…' : '建立並選取' }}
              </button>
            </div>
          </form>
        </div>

        <p v-if="quickCreateMessage" class="mt-3 text-sm font-medium" role="status">
          {{ quickCreateMessage }}
        </p>
        <p v-if="saveError" class="mt-3 text-sm text-destructive" role="alert">
          {{ saveError }}
        </p>
      </div>

      <DialogFooter class="shrink-0 border-t border-border px-5 py-4 sm:px-6">
        <button
          type="button"
          class="min-h-11 rounded-md border border-control px-5 font-semibold"
          :disabled="saving || quickCreateSaving"
          @click="cancelPicker"
        >
          取消
        </button>
        <button
          type="button"
          class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="!ready || !hasChanges || saving || quickCreateSaving"
          :aria-busy="saving"
          @click="saveMemberships"
        >
          {{ saving ? '儲存中…' : '儲存變更' }}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <div
    v-if="membershipStatus"
    class="fixed inset-x-4 bottom-4 z-[60] flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6"
  >
    <div
      class="flex w-full max-w-sm items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-popover-foreground shadow-xl"
      :class="membershipStatusIsError ? 'border-destructive/40' : ''"
      :role="membershipStatusIsError ? 'alert' : 'status'"
      :aria-live="membershipStatusIsError ? 'assertive' : 'polite'"
      aria-atomic="true"
      :aria-busy="undoBusy"
    >
      <p class="min-w-0 flex-1 text-sm font-medium leading-6">{{ membershipStatus }}</p>
      <button
        v-if="undoRecord"
        type="button"
        class="min-h-11 shrink-0 rounded-md px-3 font-semibold text-accent-caramel underline decoration-transparent underline-offset-4 transition hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-wait disabled:opacity-60"
        :disabled="undoBusy"
        :aria-busy="undoBusy"
        aria-label="復原最近一次收藏清單歸類變更"
        @click="undoLastSave"
      >
        {{ undoBusy ? '復原中…' : '復原' }}
      </button>
    </div>
  </div>
</template>
