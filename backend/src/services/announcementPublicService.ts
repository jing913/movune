import { Announcement } from '../models/announcementModel.js'
import type {
  AnnouncementCategory,
  AnnouncementGovernanceStatus,
  AnnouncementMaintenanceData,
  AnnouncementPriority,
  AnnouncementPublicationStatus,
} from '../policies/announcementLifecyclePolicy.js'
import type { AnnouncementRichTextDocument } from '../utils/announcementRichText.js'
import {
  announcementPublicSort,
  buildAnnouncementPublicCursorFilter,
  encodeAnnouncementPublicCursor,
  type AnnouncementPublicCursor,
} from '../utils/announcementPublicPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

type ObjectIdValue = Readonly<{ toString(): string }>
type ImportantUpdateValue = Readonly<{ at: Date; note: string }>

type AnnouncementListRecord = Readonly<{
  _id: ObjectIdValue
  category: AnnouncementCategory
  priority: AnnouncementPriority
  title: string
  publishedAt: Date
  effectiveAt?: Date
  orderingAt: Date
  importantUpdate?: ImportantUpdateValue | null
  maintenance?: AnnouncementMaintenanceData | null
}>

type AnnouncementStateRecord = Readonly<{
  _id: ObjectIdValue
  publicationStatus: AnnouncementPublicationStatus
  governanceStatus: AnnouncementGovernanceStatus
}>

type AnnouncementAvailableRecord = AnnouncementListRecord &
  Readonly<{ body: AnnouncementRichTextDocument }>

export type AnnouncementPublicRepository = Readonly<{
  list(
    filter: Readonly<Record<string, unknown>>,
    sort: typeof announcementPublicSort,
    limit: number,
  ): Promise<AnnouncementListRecord[]>
  findStateById(id: string): Promise<AnnouncementStateRecord | null>
  findAvailableById(id: string): Promise<AnnouncementAvailableRecord | null>
}>

const LIST_FIELDS = 'category priority title publishedAt effectiveAt importantUpdate maintenance'
const STATE_FIELDS = 'publicationStatus governanceStatus'
const AVAILABLE_FIELDS = `${LIST_FIELDS} body`

const mongooseAnnouncementPublicRepository: AnnouncementPublicRepository = {
  async list(filter, sort, limit) {
    return Announcement.aggregate<AnnouncementListRecord>([
      { $addFields: { orderingAt: { $ifNull: ['$effectiveAt', '$publishedAt'] } } },
      { $match: filter },
      { $sort: sort },
      { $limit: limit },
      {
        $project: {
          category: 1,
          priority: 1,
          title: 1,
          publishedAt: 1,
          effectiveAt: 1,
          orderingAt: 1,
          importantUpdate: 1,
          maintenance: 1,
        },
      },
    ])
  },
  async findStateById(id) {
    return (await Announcement.findById(id)
      .select(STATE_FIELDS)
      .lean()) as unknown as AnnouncementStateRecord | null
  },
  async findAvailableById(id) {
    return (await Announcement.findOne({
      _id: id,
      publicationStatus: 'published',
      governanceStatus: 'normal',
    })
      .select(AVAILABLE_FIELDS)
      .lean()) as unknown as AnnouncementAvailableRecord | null
  },
}

const shapeImportantUpdate = (importantUpdate: ImportantUpdateValue) => ({
  at: importantUpdate.at,
  note: importantUpdate.note,
})

const shapeMaintenance = (maintenance: AnnouncementMaintenanceData) => ({
  status: maintenance.status,
  startsAt: maintenance.startsAt,
  endsAt: maintenance.endsAt,
  affectedAreas: [...maintenance.affectedAreas],
  expectedImpact: maintenance.expectedImpact,
  ...(maintenance.actualCompletionTime
    ? { actualCompletionTime: maintenance.actualCompletionTime }
    : {}),
})

const shapeSharedPublicFields = (announcement: AnnouncementListRecord) => ({
  id: announcement._id.toString(),
  category: announcement.category,
  priority: announcement.priority,
  title: announcement.title,
  publishedAt: announcement.publishedAt,
  ...(announcement.effectiveAt ? { effectiveAt: announcement.effectiveAt } : {}),
  ...(announcement.importantUpdate
    ? { importantUpdate: shapeImportantUpdate(announcement.importantUpdate) }
    : {}),
  ...(announcement.category === 'system_maintenance' && announcement.maintenance
    ? { maintenance: shapeMaintenance(announcement.maintenance) }
    : {}),
})

export const listPublicAnnouncements = async (
  input: Readonly<{
    category?: AnnouncementCategory
    cursor: AnnouncementPublicCursor | null
    limit: number
  }>,
  repository: AnnouncementPublicRepository = mongooseAnnouncementPublicRepository,
) => {
  const filter = {
    publicationStatus: 'published',
    governanceStatus: 'normal',
    ...(input.category ? { category: input.category } : {}),
    ...buildAnnouncementPublicCursorFilter(input.cursor),
  }
  const records = await repository.list(filter, announcementPublicSort, input.limit + 1)
  const hasMore = records.length > input.limit
  const page = records.slice(0, input.limit)
  const last = page.at(-1)

  return {
    announcements: page.map(shapeSharedPublicFields),
    nextCursor:
      hasMore && last
        ? encodeAnnouncementPublicCursor({
            orderingAt: last.orderingAt,
            id: last._id.toString(),
          })
        : null,
  }
}

const announcementNotFound = () =>
  new ApiProblem(404, 'ANNOUNCEMENT_NOT_FOUND', 'Announcement not found')

export const getPublicAnnouncement = async (
  announcementId: string,
  repository: AnnouncementPublicRepository = mongooseAnnouncementPublicRepository,
) => {
  const state = await repository.findStateById(announcementId)
  if (!state) throw announcementNotFound()

  if (state.governanceStatus === 'exceptionally_removed') {
    return { availability: 'removed' as const, id: state._id.toString() }
  }
  if (state.publicationStatus === 'withdrawn') {
    return { availability: 'withdrawn' as const, id: state._id.toString() }
  }
  if (state.publicationStatus !== 'published') throw announcementNotFound()

  const announcement = await repository.findAvailableById(announcementId)
  if (!announcement) throw announcementNotFound()

  return {
    availability: 'available' as const,
    ...shapeSharedPublicFields(announcement),
    body: announcement.body,
  }
}
