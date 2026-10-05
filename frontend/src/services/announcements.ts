import api from '@/services/api'

export const ANNOUNCEMENT_CATEGORIES = [
  'platform_announcement',
  'feature_update',
  'system_maintenance',
] as const

export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number]
export type AnnouncementPriority = 'normal' | 'important'
export type AnnouncementMaintenanceStatus = 'scheduled' | 'in_progress' | 'completed'

export type AnnouncementRichTextMark =
  Readonly<{ type: 'bold' }> | Readonly<{ type: 'link'; href: string }>

export type AnnouncementRichTextInline =
  | Readonly<{
      type: 'text'
      text: string
      marks?: readonly AnnouncementRichTextMark[]
    }>
  | Readonly<{ type: 'line_break' }>

export type AnnouncementRichTextBlock =
  | Readonly<{
      type: 'paragraph'
      content: readonly AnnouncementRichTextInline[]
    }>
  | Readonly<{
      type: 'heading'
      level: 2 | 3
      content: readonly AnnouncementRichTextInline[]
    }>
  | Readonly<{
      type: 'unordered_list' | 'ordered_list'
      content: readonly AnnouncementRichTextListItem[]
    }>

export type AnnouncementRichTextListItem = Readonly<{
  type: 'list_item'
  content: readonly AnnouncementRichTextBlock[]
}>

export type AnnouncementRichTextDocument = Readonly<{
  type: 'document'
  content: readonly AnnouncementRichTextBlock[]
}>

export type AnnouncementMaintenance = Readonly<{
  status: AnnouncementMaintenanceStatus
  startsAt: string
  endsAt: string
  affectedAreas: readonly string[]
  expectedImpact: string
  actualCompletionTime?: string
}>

export type AnnouncementImportantUpdate = Readonly<{
  at: string
  note: string
}>

export type AnnouncementPublicListItem = Readonly<{
  id: string
  category: AnnouncementCategory
  priority: AnnouncementPriority
  title: string
  publishedAt: string
  importantUpdate?: AnnouncementImportantUpdate
  maintenance?: AnnouncementMaintenance
}>

export type AnnouncementAvailableDetail = AnnouncementPublicListItem &
  Readonly<{
    availability: 'available'
    body: AnnouncementRichTextDocument
  }>

export type AnnouncementPublicDetail =
  | AnnouncementAvailableDetail
  | Readonly<{ availability: 'withdrawn'; id: string }>
  | Readonly<{ availability: 'removed'; id: string }>

export type AnnouncementListResponse = Readonly<{
  announcements: AnnouncementPublicListItem[]
  nextCursor: string | null
}>

export type AnnouncementPublicDetailResponse = Readonly<{
  announcement: AnnouncementPublicDetail
}>

export async function listAnnouncements(
  input: {
    category?: AnnouncementCategory
    cursor?: string
    limit?: number
  } = {},
) {
  const response = await api.get<AnnouncementListResponse>('/api/announcements', {
    params: input,
  })
  return response.data
}

export async function getAnnouncement(announcementId: string) {
  const response = await api.get<AnnouncementPublicDetailResponse>(
    `/api/announcements/${encodeURIComponent(announcementId)}`,
  )
  return response.data.announcement
}
