<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQueryCache } from '@pinia/colada'
import { useRoute, useRouter } from 'vue-router'
import CollectionFormDialog from '@/components/collections/CollectionFormDialog.vue'
import CollectionMovieAddDialog from '@/components/collections/CollectionMovieAddDialog.vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  addCollectionMembership,
  deleteCollection,
  getCollection,
  getCollectionErrorMessage,
  isExistingMembershipError,
  isOwnerCollection,
  removeCollectionMembership,
  reorderCollectionMemberships,
  updateCollection,
  type CollectionDetail,
  type CollectionMembership,
  type CollectionMetadataInput,
} from '@/services/collections'
import {
  getMovieDetails,
  getMoviePrimaryTitle,
  getPosterUrl,
  type Movie,
  type MovieDetails,
} from '@/services/tmdb'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const router = useRouter()
const queryCache = useQueryCache()
const userStore = useUserStore()
const collection = ref<CollectionDetail | null>(null)
const loading = ref(true)
const loadError = ref('')
const movieByTmdbId = ref<Record<number, MovieDetails | null>>({})
const moviesLoading = ref(false)
const partialMovieError = ref(false)
const manageMode = ref(false)
const editOpen = ref(false)
const editSaving = ref(false)
const editError = ref('')
const deleteOpen = ref(false)
const deleteSaving = ref(false)
const deleteError = ref('')
const addOpen = ref(false)
const addSaving = ref(false)
const addError = ref('')
const membershipPending = ref<number | null>(null)
const membershipError = ref('')
const membershipStatus = ref('')
const membershipStatusIsError = ref(false)
const undoBusy = ref(false)
type DirectRemoveUndoRecord = { collectionId: string; tmdbId: number }
const removeUndoRecord = ref<DirectRemoveUndoRecord | null>(null)
const UNDO_LIFETIME_MS = 10_000
let membershipStatusTimer: ReturnType<typeof setTimeout> | undefined
let movieRequestVersion = 0

const collectionId = computed(() => String(route.params.id ?? ''))
const ownerCanManage = computed(() =>
  collection.value ? isOwnerCollection(collection.value) : false,
)
const memberships = computed(() =>
  [...(collection.value?.memberships ?? [])].sort(
    (left, right) => left.position - right.position || left.tmdbId - right.tmdbId,
  ),
)
const existingTmdbIds = computed(() => memberships.value.map((membership) => membership.tmdbId))

function clearMembershipStatusTimer() {
  if (membershipStatusTimer === undefined) return
  clearTimeout(membershipStatusTimer)
  membershipStatusTimer = undefined
}

function clearMembershipStatus() {
  clearMembershipStatusTimer()
  removeUndoRecord.value = null
  membershipStatus.value = ''
  membershipStatusIsError.value = false
}

function showTemporaryMembershipStatus(message: string, isError = false) {
  clearMembershipStatusTimer()
  removeUndoRecord.value = null
  membershipStatus.value = message
  membershipStatusIsError.value = isError
  membershipStatusTimer = setTimeout(() => {
    membershipStatus.value = ''
    membershipStatusIsError.value = false
    membershipStatusTimer = undefined
  }, UNDO_LIFETIME_MS)
}

function offerRemoveUndo(record: DirectRemoveUndoRecord) {
  clearMembershipStatusTimer()
  removeUndoRecord.value = record
  membershipStatus.value = '已從收藏清單移除'
  membershipStatusIsError.value = false
  membershipStatusTimer = setTimeout(() => {
    removeUndoRecord.value = null
    membershipStatus.value = ''
    membershipStatusTimer = undefined
  }, UNDO_LIFETIME_MS)
}

function showAddResult(message: string, isError = false) {
  if (removeUndoRecord.value) {
    membershipStatus.value = `${message}；先前移除仍可復原`
    membershipStatusIsError.value = isError
    return
  }
  showTemporaryMembershipStatus(message, isError)
}

async function refreshCollectionSummary() {
  await queryCache.invalidateQueries({
    key: ['collections', userStore.currentUser?._id ?? 'anonymous'],
  })
}

async function reconcileCollectionDetail() {
  const refreshed = await getCollection(collectionId.value)
  if (!isOwnerCollection(refreshed)) throw new Error('Owner collection detail is required')
  collection.value = refreshed
}

async function loadCollection() {
  clearMembershipStatus()
  loading.value = true
  loadError.value = ''
  collection.value = null
  manageMode.value = false
  try {
    if (userStore.isAuthLoading) await userStore.restoreAuth()
    collection.value = await getCollection(collectionId.value)
  } catch {
    loadError.value = '這份收藏清單不存在，或目前無法查看。'
  } finally {
    loading.value = false
  }
}

watch(
  () => memberships.value.map((membership) => membership.tmdbId).join(','),
  async () => {
    const requestVersion = ++movieRequestVersion
    movieByTmdbId.value = {}
    partialMovieError.value = false
    if (!memberships.value.length) {
      moviesLoading.value = false
      return
    }
    moviesLoading.value = true
    const results = await Promise.allSettled(
      memberships.value.map((membership) => getMovieDetails(membership.tmdbId)),
    )
    if (requestVersion !== movieRequestVersion) return
    const nextMovies: Record<number, MovieDetails | null> = {}
    results.forEach((result, index) => {
      const tmdbId = memberships.value[index]?.tmdbId
      if (tmdbId === undefined) return
      nextMovies[tmdbId] = result.status === 'fulfilled' ? result.value : null
      if (result.status === 'rejected') partialMovieError.value = true
    })
    movieByTmdbId.value = nextMovies
    moviesLoading.value = false
  },
)

function replaceMemberships(nextMemberships: CollectionMembership[]) {
  if (!collection.value) return
  collection.value = { ...collection.value, memberships: nextMemberships }
}

function openEditDialog() {
  editError.value = ''
  editOpen.value = true
}

function openDeleteDialog() {
  deleteError.value = ''
  deleteOpen.value = true
}

function openAddDialog() {
  if (!ownerCanManage.value || !manageMode.value) return
  addError.value = ''
  addOpen.value = true
}

function handleDeleteOpenChange(open: boolean) {
  if (!open && deleteSaving.value) return
  deleteOpen.value = open
}

async function saveMetadata(input: CollectionMetadataInput) {
  if (!collection.value || !ownerCanManage.value) return
  editSaving.value = true
  editError.value = ''
  try {
    const currentMemberships = collection.value.memberships ?? []
    const updated = await updateCollection(collection.value._id, input)
    collection.value = { ...updated, memberships: currentMemberships }
    await queryCache.invalidateQueries({ key: ['collections'] })
    editOpen.value = false
  } catch (error) {
    editError.value = getCollectionErrorMessage(error, '無法儲存收藏清單，請稍後再試。')
  } finally {
    editSaving.value = false
  }
}

async function removeMovie(tmdbId: number) {
  if (
    !collection.value ||
    !ownerCanManage.value ||
    membershipPending.value !== null ||
    undoBusy.value ||
    addSaving.value
  )
    return
  const targetCollectionId = collection.value._id
  membershipPending.value = tmdbId
  membershipError.value = ''
  try {
    replaceMemberships(await removeCollectionMembership(targetCollectionId, tmdbId))
  } catch {
    try {
      await reconcileCollectionDetail()
      membershipError.value = '無法移除電影，已同步目前狀態。'
    } catch {
      membershipError.value = '無法移除電影，目前狀態無法確認。請稍後再試。'
    }
    membershipPending.value = null
    return
  }

  try {
    await reconcileCollectionDetail()
  } catch {
    membershipError.value = '電影已移除，但目前無法重新載入完整清單。'
  }
  try {
    await refreshCollectionSummary()
  } catch {
    membershipError.value = '電影已移除，但收藏清單摘要目前無法重新載入。'
  }
  offerRemoveUndo({ collectionId: targetCollectionId, tmdbId })
  membershipPending.value = null
}

async function addMovie(movie: Movie) {
  if (!collection.value || !ownerCanManage.value || addSaving.value) return
  if (memberships.value.some((membership) => membership.tmdbId === movie.id)) {
    addError.value = '這部電影已在收藏清單中。'
    return
  }

  const targetCollectionId = collection.value._id
  addSaving.value = true
  addError.value = ''
  membershipError.value = ''
  try {
    replaceMemberships(await addCollectionMembership(targetCollectionId, movie.id))
  } catch (error) {
    let reconciled = false
    try {
      await reconcileCollectionDetail()
      reconciled = true
    } catch {
      // The fixed message below does not disclose raw backend details.
    }
    addError.value = isExistingMembershipError(error)
      ? '這部電影已在收藏清單中。'
      : reconciled
        ? '無法加入電影，已同步目前狀態。請稍後再試。'
        : '無法加入電影，目前狀態無法確認。請稍後再試。'
    addSaving.value = false
    return
  }

  let reconciliationFailed = false
  try {
    await reconcileCollectionDetail()
  } catch {
    reconciliationFailed = true
  }
  try {
    await refreshCollectionSummary()
  } catch {
    reconciliationFailed = true
  }
  addSaving.value = false
  addOpen.value = false
  if (
    removeUndoRecord.value?.collectionId === targetCollectionId &&
    removeUndoRecord.value.tmdbId === movie.id
  ) {
    clearMembershipStatus()
  }
  showAddResult(
    reconciliationFailed ? '電影已加入，但部分清單資料目前無法重新載入。' : '已加入收藏清單',
    reconciliationFailed,
  )
}

async function undoLastRemoval() {
  const record = removeUndoRecord.value
  if (!record || undoBusy.value || membershipPending.value !== null || addSaving.value) return

  clearMembershipStatusTimer()
  removeUndoRecord.value = null
  undoBusy.value = true
  membershipError.value = ''
  membershipStatus.value = '正在復原收藏清單變更…'
  membershipStatusIsError.value = false
  try {
    replaceMemberships(await addCollectionMembership(record.collectionId, record.tmdbId))
  } catch {
    try {
      await reconcileCollectionDetail()
      showTemporaryMembershipStatus('無法復原變更，已同步目前狀態。', true)
    } catch {
      showTemporaryMembershipStatus('無法復原變更，目前狀態無法確認。', true)
    }
    undoBusy.value = false
    return
  }

  let reconciliationFailed = false
  try {
    await reconcileCollectionDetail()
  } catch {
    reconciliationFailed = true
  }
  try {
    await refreshCollectionSummary()
  } catch {
    reconciliationFailed = true
  }
  undoBusy.value = false
  showTemporaryMembershipStatus(
    reconciliationFailed ? '變更已復原，但部分清單資料目前無法重新載入。' : '已復原收藏清單變更',
    reconciliationFailed,
  )
}

async function moveMovie(index: number, direction: -1 | 1) {
  if (!collection.value || membershipPending.value !== null) return
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= memberships.value.length) return
  const desired = memberships.value.map((membership) => membership.tmdbId)
  const current = desired[index]
  const target = desired[targetIndex]
  if (current === undefined || target === undefined) return
  desired[index] = target
  desired[targetIndex] = current
  membershipPending.value = current
  membershipError.value = ''
  try {
    replaceMemberships(await reorderCollectionMemberships(collection.value._id, desired))
  } catch (error) {
    membershipError.value = getCollectionErrorMessage(error, '無法調整順序，原有順序已保留。')
  } finally {
    membershipPending.value = null
  }
}

async function confirmDelete() {
  if (!collection.value || !ownerCanManage.value || deleteSaving.value) return
  deleteSaving.value = true
  deleteError.value = ''
  try {
    const deletedCollectionId = collection.value._id
    await deleteCollection(deletedCollectionId)
    await Promise.allSettled([
      queryCache.invalidateQueries({
        key: ['collections', userStore.currentUser?._id ?? 'anonymous'],
      }),
      queryCache.invalidateQueries({
        key: ['collections-deleted', userStore.currentUser?._id ?? 'anonymous'],
      }),
    ])
    collection.value = null
    deleteOpen.value = false
    await router.push({
      name: 'movie-space',
      query: { view: 'collections', collectionStatus: 'deleted' },
    })
  } catch {
    deleteError.value = '無法刪除收藏清單，請稍後再試。'
  } finally {
    deleteSaving.value = false
  }
}

onMounted(loadCollection)
watch(collectionId, loadCollection)
onBeforeUnmount(clearMembershipStatusTimer)
</script>

<template>
  <div class="page-shell pb-12 pt-8 sm:pt-10">
    <nav
      class="mb-6 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      aria-label="麵包屑"
    >
      <RouterLink class="rounded-md hover:text-accent-caramel" to="/">首頁</RouterLink>
      <span aria-hidden="true">/</span>
      <RouterLink
        v-if="ownerCanManage"
        class="rounded-md hover:text-accent-caramel"
        :to="{ name: 'movie-space', query: { view: 'collections' } }"
      >
        收藏清單
      </RouterLink>
      <span v-if="ownerCanManage" aria-hidden="true">/</span>
      <span v-if="collection" class="max-w-64 truncate text-foreground" aria-current="page">
        {{ collection.name }}
      </span>
    </nav>

    <div v-if="loading" class="space-y-6" aria-label="收藏清單載入中">
      <div class="h-36 animate-pulse rounded-xl bg-secondary"></div>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="index in 6"
          :key="index"
          class="h-56 animate-pulse rounded-lg bg-secondary"
        ></div>
      </div>
    </div>

    <div
      v-else-if="loadError || !collection"
      class="rounded-xl border border-border bg-card px-6 py-16 text-center"
      role="alert"
    >
      <h1 class="text-2xl font-bold">收藏清單無法顯示</h1>
      <p class="mt-3 text-sm text-muted-foreground">{{ loadError }}</p>
      <button
        type="button"
        class="mt-6 min-h-11 rounded-md border border-control px-5 font-semibold"
        @click="loadCollection"
      >
        再試一次
      </button>
    </div>

    <template v-else>
      <header
        class="rounded-xl border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-8"
      >
        <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <p
              class="font-display-en text-xs font-semibold uppercase tracking-[0.18em] text-accent-caramel"
            >
              Collection
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">{{ collection.name }}</h1>
              <span
                v-if="ownerCanManage"
                class="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground"
              >
                {{
                  isOwnerCollection(collection) && collection.visibility === 'public'
                    ? '公開'
                    : '私人'
                }}
              </span>
            </div>
            <p v-if="collection.description" class="mt-3 max-w-3xl leading-7 text-muted-foreground">
              {{ collection.description }}
            </p>
            <p class="mt-3 text-sm text-muted-foreground">{{ memberships.length }} 部電影</p>
          </div>
          <div v-if="ownerCanManage" class="flex flex-wrap gap-2">
            <button
              type="button"
              class="min-h-11 rounded-md border border-control px-4 font-semibold hover:border-accent-caramel"
              @click="openEditDialog"
            >
              編輯清單
            </button>
            <button
              type="button"
              class="min-h-11 rounded-md border border-destructive/50 px-4 font-semibold text-destructive hover:bg-destructive/10"
              @click="openDeleteDialog"
            >
              刪除清單
            </button>
          </div>
        </div>
      </header>

      <section class="mt-8" aria-labelledby="collection-movies-heading">
        <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="collection-movies-heading" class="text-2xl font-bold">電影</h2>
            <p v-if="manageMode" class="mt-1 text-sm text-muted-foreground">
              加入電影，或使用上移、下移調整正式順序；每次操作都會立即儲存。
            </p>
          </div>
          <div v-if="ownerCanManage" class="flex flex-wrap gap-2">
            <button
              v-if="manageMode"
              type="button"
              class="min-h-11 rounded-md bg-primary-cta px-4 font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
              :disabled="addSaving || undoBusy || membershipPending !== null"
              @click="openAddDialog"
            >
              加入電影
            </button>
            <button
              type="button"
              class="min-h-11 rounded-md border border-control px-4 font-semibold"
              :aria-pressed="manageMode"
              @click="manageMode = !manageMode"
            >
              {{ manageMode ? '完成管理' : '管理電影' }}
            </button>
          </div>
        </div>

        <p v-if="membershipError" class="mb-4 text-sm text-destructive" role="alert">
          {{ membershipError }}
        </p>
        <p
          v-if="partialMovieError"
          class="mb-4 rounded-md bg-secondary p-4 text-sm text-muted-foreground"
          role="status"
        >
          部分電影資料暫時無法載入；清單成員與順序仍完整保留。
        </p>
        <div
          v-if="!memberships.length"
          class="rounded-lg border border-border bg-card px-6 py-12 text-center"
          role="status"
        >
          <p class="text-lg font-semibold">這份收藏清單目前沒有電影</p>
          <p v-if="ownerCanManage" class="mt-2 text-sm text-muted-foreground">
            {{ manageMode ? '使用「加入電影」加入第一部電影。' : '進入管理模式即可加入電影。' }}
          </p>
          <RouterLink
            v-if="ownerCanManage"
            to="/explore"
            class="mt-5 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground"
          >
            探索電影
          </RouterLink>
        </div>
        <div
          v-else-if="moviesLoading"
          class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="電影資料載入中"
        >
          <div
            v-for="index in memberships.length"
            :key="index"
            class="h-64 animate-pulse rounded-lg bg-secondary"
          ></div>
        </div>
        <ol v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="收藏清單電影">
          <li
            v-for="(membership, index) in memberships"
            :key="membership.tmdbId"
            class="flex min-w-0 flex-col rounded-lg border border-border bg-card p-4"
          >
            <RouterLink
              :to="`/movies/${membership.tmdbId}`"
              class="group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <div class="aspect-[2/3] overflow-hidden rounded-sm bg-secondary">
                <img
                  v-if="movieByTmdbId[membership.tmdbId]?.poster_path"
                  :src="getPosterUrl(movieByTmdbId[membership.tmdbId]!.poster_path!)"
                  :alt="`${getMoviePrimaryTitle(movieByTmdbId[membership.tmdbId]!)}電影海報`"
                  class="size-full object-cover transition group-hover:scale-[1.02] motion-reduce:transform-none"
                />
                <div
                  v-else
                  class="flex size-full items-center justify-center text-muted-foreground"
                  role="img"
                  aria-label="沒有電影海報"
                >
                  <span class="text-center">TMDB<br />{{ membership.tmdbId }}</span>
                </div>
              </div>
              <h3 class="mt-3 line-clamp-2 font-bold group-hover:text-accent-caramel">
                {{
                  movieByTmdbId[membership.tmdbId]
                    ? getMoviePrimaryTitle(movieByTmdbId[membership.tmdbId]!)
                    : `電影 ${membership.tmdbId}`
                }}
              </h3>
            </RouterLink>
            <div v-if="manageMode && ownerCanManage" class="mt-auto grid grid-cols-2 gap-2 pt-4">
              <button
                type="button"
                class="min-h-11 rounded-md border border-control text-sm font-semibold disabled:opacity-40"
                :disabled="index === 0 || membershipPending !== null || undoBusy || addSaving"
                :aria-label="`上移${movieByTmdbId[membership.tmdbId] ? getMoviePrimaryTitle(movieByTmdbId[membership.tmdbId]!) : `電影 ${membership.tmdbId}`}`"
                @click="moveMovie(index, -1)"
              >
                上移
              </button>
              <button
                type="button"
                class="min-h-11 rounded-md border border-control text-sm font-semibold disabled:opacity-40"
                :disabled="
                  index === memberships.length - 1 ||
                  membershipPending !== null ||
                  undoBusy ||
                  addSaving
                "
                :aria-label="`下移${movieByTmdbId[membership.tmdbId] ? getMoviePrimaryTitle(movieByTmdbId[membership.tmdbId]!) : `電影 ${membership.tmdbId}`}`"
                @click="moveMovie(index, 1)"
              >
                下移
              </button>
              <button
                type="button"
                class="col-span-2 min-h-11 rounded-md border border-destructive/50 text-sm font-semibold text-destructive disabled:opacity-40"
                :disabled="membershipPending !== null || undoBusy || addSaving"
                :aria-label="`從清單移除${movieByTmdbId[membership.tmdbId] ? getMoviePrimaryTitle(movieByTmdbId[membership.tmdbId]!) : `電影 ${membership.tmdbId}`}`"
                @click="removeMovie(membership.tmdbId)"
              >
                {{ membershipPending === membership.tmdbId ? '儲存中…' : '從清單移除' }}
              </button>
            </div>
          </li>
        </ol>
      </section>

      <CollectionFormDialog
        v-if="isOwnerCollection(collection)"
        v-model:open="editOpen"
        mode="edit"
        :initial-name="collection.name"
        :initial-description="collection.description ?? ''"
        :initial-visibility="collection.visibility"
        :saving="editSaving"
        :error="editError"
        @submit="saveMetadata"
      />

      <CollectionMovieAddDialog
        v-if="isOwnerCollection(collection)"
        v-model:open="addOpen"
        :collection-name="collection.name"
        :existing-tmdb-ids="existingTmdbIds"
        :adding="addSaving"
        :add-error="addError"
        @clear-error="addError = ''"
        @select="addMovie"
      />

      <Dialog :open="deleteOpen" @update:open="handleDeleteOpenChange">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>刪除「{{ collection.name }}」？</DialogTitle>
            <DialogDescription>
              這個收藏清單會從你的電影空間中移除。清單中的電影不會被刪除，你之後仍可復原這個收藏清單。
            </DialogDescription>
          </DialogHeader>
          <p v-if="deleteError" class="text-sm text-destructive" role="alert">{{ deleteError }}</p>
          <DialogFooter>
            <button
              type="button"
              class="min-h-11 rounded-md border border-control px-5 font-semibold"
              :disabled="deleteSaving"
              @click="deleteOpen = false"
            >
              取消
            </button>
            <button
              type="button"
              class="min-h-11 rounded-md bg-destructive px-5 font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-wait disabled:opacity-60"
              :disabled="deleteSaving"
              :aria-busy="deleteSaving"
              @click="confirmDelete"
            >
              {{ deleteSaving ? '刪除中…' : '刪除收藏清單' }}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div
        v-if="membershipStatus"
        class="fixed inset-x-4 bottom-4 z-50 flex justify-center sm:inset-x-auto sm:right-6"
      >
        <div
          class="flex w-full max-w-md items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 shadow-lg sm:w-auto sm:min-w-80"
          :role="membershipStatusIsError ? 'alert' : 'status'"
          :aria-live="membershipStatusIsError ? 'assertive' : 'polite'"
          :aria-busy="undoBusy"
        >
          <p class="text-sm font-medium">{{ membershipStatus }}</p>
          <button
            v-if="removeUndoRecord"
            type="button"
            class="min-h-11 shrink-0 rounded-md px-3 font-semibold text-accent-caramel hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            :disabled="undoBusy"
            @click="undoLastRemoval"
          >
            復原
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
