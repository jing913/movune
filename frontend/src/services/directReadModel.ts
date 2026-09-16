import type {
  DirectConversationDetailDto,
  DirectConversationDto,
  DirectConversationPage,
  DirectView,
} from './messaging'

export const messageTabs = [
  { id: 'conversations', label: '對話' },
  { id: 'requests', label: '邀請' },
] as const

export const directViewFromDetail = (detail: Pick<DirectConversationDetailDto, 'bucket'>) =>
  detail.bucket

export const inboxLinkLabel = (needsAttention: boolean) =>
  needsAttention ? '收件匣，有未讀內容或待處理邀請' : '收件匣'

export const directListQuery = (view: DirectView, cursor?: string) => ({
  view,
  limit: 20,
  ...(cursor ? { cursor } : {}),
})

export function mergeDirectConversationRows(
  current: DirectConversationDto[],
  incoming: DirectConversationDto[],
) {
  const seen = new Set(current.map((row) => row.id))
  return [...current, ...incoming.filter((row) => !seen.has(row.id))]
}

type CommitDirectPage = (
  view: DirectView,
  rows: DirectConversationDto[],
  nextCursor: string | null,
) => void

export function createDirectListCoordinator(
  load: (view: DirectView, cursor?: string) => Promise<DirectConversationPage>,
  commit: CommitDirectPage,
) {
  let requestVersion = 0

  const replace = async (view: DirectView) => {
    const version = ++requestVersion
    let page: DirectConversationPage
    try {
      page = await load(view)
    } catch (error) {
      if (version !== requestVersion) return false
      throw error
    }
    if (version !== requestVersion) return false
    commit(view, page.conversations, page.nextCursor)
    return true
  }

  const append = async (view: DirectView, cursor: string, current: DirectConversationDto[]) => {
    const version = ++requestVersion
    let page: DirectConversationPage
    try {
      page = await load(view, cursor)
    } catch (error) {
      if (version !== requestVersion) return false
      throw error
    }
    if (version !== requestVersion) return false
    commit(view, mergeDirectConversationRows(current, page.conversations), page.nextCursor)
    return true
  }

  const cancel = () => {
    requestVersion += 1
  }

  return { replace, append, cancel }
}

export function tabFocusTarget(key: string, index: number, count: number) {
  if (key === 'ArrowRight' || key === 'Right') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'Left') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
