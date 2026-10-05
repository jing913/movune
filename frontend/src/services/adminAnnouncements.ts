import api from '@/services/api'
import type {
  AnnouncementCategory,
  AnnouncementPriority,
  AnnouncementRichTextDocument,
} from '@/services/announcements'

export type AnnouncementPublicationStatus = 'draft' | 'published' | 'withdrawn'
export type AnnouncementGovernanceStatus = 'normal' | 'exceptionally_removed'
export type AnnouncementMaintenanceStatus = 'scheduled' | 'in_progress' | 'completed'

export type AnnouncementAdminMaintenance = Readonly<{
  status?: AnnouncementMaintenanceStatus
  startsAt?: string
  endsAt?: string
  affectedAreas?: readonly string[]
  expectedImpact?: string
  actualCompletionTime?: string
}>

export type AnnouncementAdminListItem = Readonly<{
  id: string
  category: AnnouncementCategory
  priority: AnnouncementPriority
  publicationStatus: AnnouncementPublicationStatus
  governanceStatus: AnnouncementGovernanceStatus
  title?: string
  publishedAt?: string
  importantUpdate?: Readonly<{ at: string; note: string }>
  maintenance?: AnnouncementAdminMaintenance
  revision: number
  createdAt: string
  updatedAt: string
}>

export type AnnouncementAdminDetail = AnnouncementAdminListItem &
  Readonly<{ body?: AnnouncementRichTextDocument }>

export type AnnouncementAdminListResponse = Readonly<{
  announcements: AnnouncementAdminListItem[]
  nextCursor: string | null
}>

type AnnouncementEnvelope = Readonly<{ announcement: AnnouncementAdminDetail }>

export type AnnouncementDraftInput = Readonly<{
  expectedRevision: number
  category: AnnouncementCategory
  priority: AnnouncementPriority
  title?: string
  body?: AnnouncementRichTextDocument
  maintenance?: AnnouncementAdminMaintenance
}>

export type AnnouncementPublishedEditInput = Readonly<{
  expectedRevision: number
  editIntent: 'general_correction' | 'important_update'
  category: AnnouncementCategory
  priority: AnnouncementPriority
  title: string
  body: AnnouncementRichTextDocument
  maintenance?: AnnouncementAdminMaintenance
  updateNote?: string
}>

const detail = (response: { data: AnnouncementEnvelope }) => response.data.announcement

export async function listAdminAnnouncements(input: { cursor?: string; limit?: number } = {}) {
  return (
    await api.get<AnnouncementAdminListResponse>('/api/admin/announcements', { params: input })
  ).data
}

export async function getAdminAnnouncement(id: string) {
  return detail(
    await api.get<AnnouncementEnvelope>(`/api/admin/announcements/${encodeURIComponent(id)}`),
  )
}

export async function createAnnouncementDraft(input: {
  category: AnnouncementCategory
  priority: AnnouncementPriority
}) {
  return detail(await api.post<AnnouncementEnvelope>('/api/admin/announcements', input))
}

export async function saveAnnouncementDraft(id: string, input: AnnouncementDraftInput) {
  return detail(
    await api.patch<AnnouncementEnvelope>(
      `/api/admin/announcements/${encodeURIComponent(id)}`,
      input,
    ),
  )
}

export async function deleteAnnouncementDraft(id: string, expectedRevision: number) {
  return (
    await api.delete<Readonly<{ deleted: true; id: string }>>(
      `/api/admin/announcements/${encodeURIComponent(id)}`,
      { data: { expectedRevision } },
    )
  ).data
}

const revisionAction = async (
  id: string,
  action: 'publish' | 'withdraw' | 'restore',
  expectedRevision: number,
) =>
  detail(
    await api.post<AnnouncementEnvelope>(
      `/api/admin/announcements/${encodeURIComponent(id)}/${action}`,
      { expectedRevision },
    ),
  )

export const publishAnnouncement = (id: string, expectedRevision: number) =>
  revisionAction(id, 'publish', expectedRevision)
export const withdrawAnnouncement = (id: string, expectedRevision: number) =>
  revisionAction(id, 'withdraw', expectedRevision)
export const restoreAnnouncement = (id: string, expectedRevision: number) =>
  revisionAction(id, 'restore', expectedRevision)

export async function editPublishedAnnouncement(id: string, input: AnnouncementPublishedEditInput) {
  return detail(
    await api.patch<AnnouncementEnvelope>(
      `/api/admin/announcements/${encodeURIComponent(id)}/published-content`,
      input,
    ),
  )
}

export async function transitionAnnouncementMaintenance(
  id: string,
  input: Readonly<{
    expectedRevision: number
    status: AnnouncementMaintenanceStatus
    actualCompletionTime?: string
  }>,
) {
  return detail(
    await api.post<AnnouncementEnvelope>(
      `/api/admin/announcements/${encodeURIComponent(id)}/maintenance-transition`,
      input,
    ),
  )
}
