import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getEncounterCandidates, type EncounterCandidate } from '@/services/users'

export type EncounterPhase = 'entry' | 'active' | 'reveal' | 'result'
export type EncounterRevealState =
  'mystery' | 'movieReveal' | 'dnaReveal' | 'neutralReveal' | 'personReveal'
export type EncounterLoadState = 'idle' | 'loading' | 'insufficient' | 'empty' | 'error'

export interface EncounterSharedMovie {
  tmdbId: number
  title: string
  posterPath: string | null
}

export const useEncounterStore = defineStore('encounter', () => {
  const ownerUserId = ref<string | null>(null)
  const sessionExcludedIds = ref<string[]>([])
  const previousRoundCooldownIds = ref<string[]>([])
  const currentCandidates = ref<EncounterCandidate[]>([])
  const selectedCandidate = ref<EncounterCandidate | null>(null)
  const selectedSharedMovies = ref<EncounterSharedMovie[]>([])
  const currentRound = ref(0)
  const phase = ref<EncounterPhase>('entry')
  const revealState = ref<EncounterRevealState>('mystery')
  const loadState = ref<EncounterLoadState>('idle')

  const isLoading = computed(() => loadState.value === 'loading')

  function reset(userId: string | null = ownerUserId.value) {
    ownerUserId.value = userId
    sessionExcludedIds.value = []
    previousRoundCooldownIds.value = []
    currentCandidates.value = []
    selectedCandidate.value = null
    selectedSharedMovies.value = []
    currentRound.value = 0
    phase.value = 'entry'
    revealState.value = 'mystery'
    loadState.value = 'idle'
  }

  function ensureSession(userId: string) {
    if (ownerUserId.value !== userId) reset(userId)
  }

  async function loadRound(userId: string, accessToken: string) {
    ensureSession(userId)
    if (isLoading.value) return

    const retryingFailedRound = loadState.value === 'error'
    const cooldownIds = retryingFailedRound
      ? previousRoundCooldownIds.value
      : currentCandidates.value
          .map((candidate) => candidate._id)
          .filter((candidateId) => !sessionExcludedIds.value.includes(candidateId))
    loadState.value = 'loading'
    previousRoundCooldownIds.value = cooldownIds
    currentCandidates.value = []
    selectedCandidate.value = null
    selectedSharedMovies.value = []
    revealState.value = 'mystery'

    try {
      const result = await getEncounterCandidates(
        sessionExcludedIds.value,
        cooldownIds,
        accessToken,
      )
      currentCandidates.value = result.candidates
      phase.value = 'active'
      loadState.value =
        result.status === 'insufficient_signal'
          ? 'insufficient'
          : result.candidates.length > 0
            ? 'idle'
            : 'empty'
      if (result.candidates.length > 0) currentRound.value += 1
    } catch {
      loadState.value = 'error'
    }
  }

  function selectCandidate(candidateId: string) {
    if (phase.value !== 'active' || loadState.value !== 'idle') return false
    const candidate = currentCandidates.value.find((item) => item._id === candidateId)
    if (!candidate) return false

    selectedCandidate.value = candidate
    selectedSharedMovies.value = []
    phase.value = 'reveal'
    revealState.value = 'mystery'
    return true
  }

  function showEvidenceReveal() {
    if (!selectedCandidate.value || phase.value !== 'reveal') return
    sessionExcludedIds.value = [
      ...new Set([...sessionExcludedIds.value, selectedCandidate.value._id]),
    ]
    revealState.value = selectedCandidate.value.revealableSharedFavoriteTmdbIds.length
      ? 'movieReveal'
      : selectedCandidate.value.sharedDnaGenres.length
        ? 'dnaReveal'
        : 'neutralReveal'
  }

  function showPersonReveal() {
    if (!selectedCandidate.value || phase.value !== 'reveal') return
    revealState.value = 'personReveal'
    phase.value = 'result'
  }

  function setSelectedSharedMovies(movies: EncounterSharedMovie[]) {
    selectedSharedMovies.value = movies.slice(0, 3)
  }

  return {
    sessionExcludedIds,
    previousRoundCooldownIds,
    currentCandidates,
    selectedCandidate,
    selectedSharedMovies,
    currentRound,
    phase,
    revealState,
    loadState,
    isLoading,
    reset,
    ensureSession,
    loadRound,
    selectCandidate,
    showEvidenceReveal,
    showPersonReveal,
    setSelectedSharedMovies,
  }
})
