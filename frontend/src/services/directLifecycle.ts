import type { DirectConversationDetailDto, DirectConversationDto, DirectView } from './messaging'

export type DirectLifecycleAction = 'accept' | 'decline' | 'reply'

export type DirectLifecycleLockChange = Readonly<{
  conversationId: string
  action: DirectLifecycleAction | null
}>

export type DirectPresentationToken = Readonly<{
  conversationId: string
  generation: number
}>

export function createDirectPresentationOwnership(getActiveConversationId: () => string | null) {
  let generation = 0

  return {
    capture(conversationId: string): DirectPresentationToken {
      return { conversationId, generation }
    },
    invalidate() {
      generation += 1
    },
    owns(token: DirectPresentationToken) {
      return token.generation === generation && getActiveConversationId() === token.conversationId
    },
  }
}

export const isCurrentDirectReconciliation = (requestVersion: number, currentVersion: number) =>
  requestVersion === currentVersion

export function directResolutionControls(
  conversation: Pick<DirectConversationDto, 'capabilities'> | null,
  unavailable = false,
) {
  const capabilities = conversation?.capabilities
  return {
    showAccept: capabilities?.canAccept === true,
    showDecline: capabilities?.canDecline === true,
    mayReply: capabilities?.canSendMessage === true,
    disabled: unavailable,
  } as const
}

export function createDirectLifecycleMutationLock(
  onChange: (change: DirectLifecycleLockChange) => void = () => {},
) {
  const active = new Map<string, DirectLifecycleAction>()

  const run = async <T>(
    conversationId: string,
    action: DirectLifecycleAction,
    operation: () => Promise<T>,
  ): Promise<{ executed: true; value: T } | { executed: false }> => {
    if (active.has(conversationId)) return { executed: false }
    active.set(conversationId, action)
    onChange({ conversationId, action })
    try {
      return { executed: true, value: await operation() }
    } finally {
      active.delete(conversationId)
      onChange({ conversationId, action: null })
    }
  }

  return {
    run,
    isLocked: (conversationId: string) => active.has(conversationId),
    actionFor: (conversationId: string) => active.get(conversationId) ?? null,
  }
}

type AuthoritativeConvergenceOptions = Readonly<{
  conversation: DirectConversationDetailDto
  originatingView: DirectView
  install: (conversation: DirectConversationDetailDto) => void
  replaceRoute: (view: DirectView, conversationId: string) => Promise<unknown>
  reconcileProjection: (view: DirectView) => Promise<unknown>
  refreshSummary: () => Promise<unknown>
  focusDetail?: () => Promise<unknown> | unknown
  ownsPresentation: () => boolean
  shouldReplaceRoute?: (view: DirectView) => boolean
}>

export async function convergeAuthoritativeDirectConversation({
  conversation,
  originatingView,
  install,
  replaceRoute,
  reconcileProjection,
  refreshSummary,
  focusDetail,
  ownsPresentation,
  shouldReplaceRoute = () => true,
}: AuthoritativeConvergenceOptions) {
  const reconcileViews = [...new Set([originatingView, conversation.bucket])]
  if (!ownsPresentation()) {
    const secondary = Promise.allSettled([
      ...reconcileViews.map(reconcileProjection),
      refreshSummary(),
    ])
    return { applied: false, secondary }
  }

  install(conversation)
  if (ownsPresentation() && shouldReplaceRoute(conversation.bucket)) {
    await Promise.allSettled([replaceRoute(conversation.bucket, conversation.id)])
  }
  const secondary = Promise.allSettled([
    ...reconcileViews.map(reconcileProjection),
    refreshSummary(),
  ])
  if (focusDetail && ownsPresentation()) await focusDetail()
  return { applied: true, secondary }
}

type BackgroundDirectReconciliationOptions = Readonly<{
  conversationId: string
  originatingView: DirectView
  loadConversation: () => Promise<DirectConversationDetailDto>
  markAuthorityStale: () => void
  install: (conversation: DirectConversationDetailDto) => void
  currentView: () => DirectView
  replaceRoute: (view: DirectView, conversationId: string) => Promise<unknown>
  reconcileProjection: (view: DirectView) => Promise<unknown>
  refreshSummary: () => Promise<unknown>
  ownsPresentation: () => boolean
  isCurrentRequest: () => boolean
}>

export async function reconcileBackgroundDirectConversation({
  conversationId,
  originatingView,
  loadConversation,
  markAuthorityStale,
  install,
  currentView,
  replaceRoute,
  reconcileProjection,
  refreshSummary,
  ownsPresentation,
  isCurrentRequest,
}: BackgroundDirectReconciliationOptions) {
  markAuthorityStale()
  try {
    const conversation = await loadConversation()
    const ownsCurrentPresentation = () =>
      ownsPresentation() && isCurrentRequest() && conversation.id === conversationId
    if (!ownsCurrentPresentation()) return { applied: false, status: 'superseded' as const }

    const convergence = await convergeAuthoritativeDirectConversation({
      conversation,
      originatingView,
      install,
      replaceRoute,
      reconcileProjection,
      refreshSummary,
      ownsPresentation: ownsCurrentPresentation,
      shouldReplaceRoute: (view) => currentView() !== view,
    })
    return {
      applied: convergence.applied,
      status: convergence.applied ? ('applied' as const) : ('superseded' as const),
      secondary: convergence.secondary,
    }
  } catch {
    return { applied: false, status: 'failed' as const }
  }
}

type OrdinaryDirectFreshnessOptions = Readonly<{
  view: DirectView
  ownsPresentation: () => boolean
  reconcileProjection: (view: DirectView) => Promise<unknown>
}>

export async function reconcileOwnedOrdinaryDirectSend({
  view,
  ownsPresentation,
  reconcileProjection,
}: OrdinaryDirectFreshnessOptions) {
  if (!ownsPresentation()) return false
  try {
    await reconcileProjection(view)
  } catch {
    // The successful message mutation remains authoritative when secondary list freshness fails.
  }
  return true
}

type OwnedDirectSendOptions = Readonly<{
  ownsPresentation: () => boolean
  insertMessage: () => void
  applyConversation: () => Promise<unknown>
  clearDraft: () => void
  reconcileInactive: () => void
}>

export async function commitOwnedDirectSend({
  ownsPresentation,
  insertMessage,
  applyConversation,
  clearDraft,
  reconcileInactive,
}: OwnedDirectSendOptions) {
  if (!ownsPresentation()) {
    reconcileInactive()
    return false
  }
  insertMessage()
  await applyConversation()
  if (!ownsPresentation()) return false
  clearDraft()
  return true
}

type OwnedFailureOptions = Readonly<{
  ownsPresentation: () => boolean
  applyError: () => void
  reconcile: () => Promise<unknown>
}>

export async function applyOwnedLifecycleFailure({
  ownsPresentation,
  applyError,
  reconcile,
}: OwnedFailureOptions) {
  if (!ownsPresentation()) return false
  applyError()
  await reconcile()
  return true
}

const staleAuthorityCodes = new Set([
  'DIRECT_UNAVAILABLE',
  'DIRECT_PENDING',
  'DIRECT_DECLINED',
  'DIRECT_STATE_CONFLICT',
  'DIRECT_NOT_REQUEST_RECIPIENT',
  'RESOURCE_NOT_FOUND',
])

export function directLifecycleProblem(error: unknown) {
  const code = (error as { response?: { data?: { error?: { code?: unknown } } } }).response?.data
    ?.error?.code
  const normalizedCode = typeof code === 'string' ? code : null

  if (normalizedCode === 'INVALID_INPUT') {
    return {
      code: normalizedCode,
      message: '請求資料無效，請返回清單後再試一次。',
      reconcile: false,
    } as const
  }

  if (normalizedCode && staleAuthorityCodes.has(normalizedCode)) {
    return {
      code: normalizedCode,
      message: '對話狀態已變更，已重新載入最新狀態。',
      reconcile: true,
    } as const
  }

  return {
    code: normalizedCode,
    message: '目前無法完成操作，請稍後再試。',
    reconcile: false,
  } as const
}
