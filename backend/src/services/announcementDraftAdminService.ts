import type { QueryFilter, UpdateQuery } from 'mongoose'
import {
  Announcement,
  type AnnouncementDraftMaintenanceData,
  type IAnnouncement,
} from '../models/announcementModel.js'
import type {
  AnnouncementCategory,
  AnnouncementGovernanceStatus,
  AnnouncementPriority,
  AnnouncementPublicationStatus,
} from '../policies/announcementLifecyclePolicy.js'
import {
  validateAnnouncementDraft,
  type AnnouncementValidationIssue,
} from '../policies/announcementValidationPolicy.js'
import type { AnnouncementRichTextDocument } from '../utils/announcementRichText.js'
import type { AnnouncementEffectiveAtBasis } from '../utils/announcementHistoricalPolicy.js'
import {
  announcementAdminSort,
  buildAnnouncementAdminCursorFilter,
  encodeAnnouncementAdminCursor,
  type AnnouncementAdminCursor,
  type AnnouncementCreateRequest,
  type AnnouncementSaveRequest,
} from '../utils/announcementAdminPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

type ObjectIdValue = Readonly<{ toString(): string }>
type ImportantUpdateValue = Readonly<{ at: Date; note: string }>

export type AnnouncementAdminRecord = Readonly<{
  _id: ObjectIdValue
  category: AnnouncementCategory
  priority: AnnouncementPriority
  title?: string
  body?: AnnouncementRichTextDocument
  publicationStatus: AnnouncementPublicationStatus
  governanceStatus: AnnouncementGovernanceStatus
  publishedAt?: Date
  effectiveAt?: Date
  effectiveAtBasis?: AnnouncementEffectiveAtBasis
  importantUpdate?: ImportantUpdateValue | null
  maintenance?: AnnouncementDraftMaintenanceData | null
  revision: number
  createdAt: Date
  updatedAt: Date
}>

type AnnouncementStateRecord = Pick<
  AnnouncementAdminRecord,
  '_id' | 'publicationStatus' | 'governanceStatus' | 'revision'
>

export type AnnouncementDraftAdminRepository = Readonly<{
  list(
    filter: QueryFilter<IAnnouncement>,
    sort: typeof announcementAdminSort,
    limit: number,
  ): Promise<AnnouncementAdminRecord[]>
  findById(id: string): Promise<AnnouncementAdminRecord | null>
  findStateById(id: string): Promise<AnnouncementStateRecord | null>
  create(value: Readonly<Record<string, unknown>>): Promise<AnnouncementAdminRecord>
  save(
    filter: QueryFilter<IAnnouncement>,
    update: UpdateQuery<IAnnouncement>,
  ): Promise<AnnouncementAdminRecord | null>
  delete(filter: QueryFilter<IAnnouncement>): Promise<boolean>
}>

const ADMIN_FIELDS =
  'category priority title body publicationStatus governanceStatus publishedAt effectiveAt effectiveAtBasis importantUpdate maintenance revision createdAt updatedAt'
const STATE_FIELDS = 'publicationStatus governanceStatus revision'

const mongooseRepository: AnnouncementDraftAdminRepository = {
  async list(filter, sort, limit) {
    return (await Announcement.find(filter)
      .select(ADMIN_FIELDS)
      .sort(sort)
      .limit(limit)
      .lean()) as unknown as AnnouncementAdminRecord[]
  },
  async findById(id) {
    return (await Announcement.findById(id)
      .select(ADMIN_FIELDS)
      .lean()) as unknown as AnnouncementAdminRecord | null
  },
  async findStateById(id) {
    return (await Announcement.findById(id)
      .select(STATE_FIELDS)
      .lean()) as unknown as AnnouncementStateRecord | null
  },
  async create(value) {
    const created = await Announcement.create(value)
    return created.toObject() as unknown as AnnouncementAdminRecord
  },
  async save(filter, update) {
    return (await Announcement.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
    })
      .select(ADMIN_FIELDS)
      .lean()) as unknown as AnnouncementAdminRecord | null
  },
  async delete(filter) {
    return (await Announcement.findOneAndDelete(filter).select('_id').lean()) !== null
  },
}

const shapeImportantUpdate = (value: ImportantUpdateValue) => ({ at: value.at, note: value.note })

const shapeMaintenance = (value: AnnouncementDraftMaintenanceData) => ({
  ...(value.status !== undefined ? { status: value.status } : {}),
  ...(value.startsAt !== undefined ? { startsAt: value.startsAt } : {}),
  ...(value.endsAt !== undefined ? { endsAt: value.endsAt } : {}),
  ...(value.affectedAreas !== undefined ? { affectedAreas: [...value.affectedAreas] } : {}),
  ...(value.expectedImpact !== undefined ? { expectedImpact: value.expectedImpact } : {}),
  ...(value.actualCompletionTime !== undefined
    ? { actualCompletionTime: value.actualCompletionTime }
    : {}),
})

const shapeShared = (record: AnnouncementAdminRecord) => ({
  id: record._id.toString(),
  category: record.category,
  priority: record.priority,
  publicationStatus: record.publicationStatus,
  governanceStatus: record.governanceStatus,
  ...(record.publishedAt !== undefined ? { publishedAt: record.publishedAt } : {}),
  ...(record.effectiveAt !== undefined ? { effectiveAt: record.effectiveAt } : {}),
  ...(record.effectiveAtBasis !== undefined ? { effectiveAtBasis: record.effectiveAtBasis } : {}),
  revision: record.revision,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

export const shapeAnnouncementAdminListItem = (record: AnnouncementAdminRecord) => ({
  ...shapeShared(record),
  ...(record.governanceStatus !== 'exceptionally_removed' && record.title !== undefined
    ? { title: record.title }
    : {}),
  ...(record.governanceStatus !== 'exceptionally_removed' && record.importantUpdate
    ? { importantUpdate: shapeImportantUpdate(record.importantUpdate) }
    : {}),
  ...(record.governanceStatus !== 'exceptionally_removed' && record.maintenance
    ? { maintenance: shapeMaintenance(record.maintenance) }
    : {}),
})

export const shapeAnnouncementAdminDetail = (record: AnnouncementAdminRecord) => ({
  ...shapeAnnouncementAdminListItem(record),
  ...(record.governanceStatus !== 'exceptionally_removed' && record.body !== undefined
    ? { body: record.body }
    : {}),
})

const notFound = () => new ApiProblem(404, 'ANNOUNCEMENT_NOT_FOUND', 'Announcement not found')
const stateConflict = () =>
  new ApiProblem(409, 'ANNOUNCEMENT_STATE_CONFLICT', 'Announcement state conflict')
const revisionConflict = () =>
  new ApiProblem(409, 'ANNOUNCEMENT_REVISION_CONFLICT', 'Announcement revision conflict')

const draftInvalid = (issues: readonly AnnouncementValidationIssue[]) =>
  new ApiProblem(400, 'ANNOUNCEMENT_DRAFT_INVALID', 'Announcement Draft is invalid', { issues })

const classifyFailedMutation = async (
  id: string,
  expectedRevision: number,
  repository: AnnouncementDraftAdminRepository,
): Promise<never> => {
  const state = await repository.findStateById(id)
  if (!state) throw notFound()
  if (state.publicationStatus !== 'draft' || state.governanceStatus !== 'normal') {
    throw stateConflict()
  }
  if (state.revision !== expectedRevision) throw revisionConflict()
  throw stateConflict()
}

export const listAdminAnnouncements = async (
  input: Readonly<{ cursor: AnnouncementAdminCursor | null; limit: number }>,
  repository: AnnouncementDraftAdminRepository = mongooseRepository,
) => {
  const records = await repository.list(
    buildAnnouncementAdminCursorFilter(input.cursor),
    announcementAdminSort,
    input.limit + 1,
  )
  const hasMore = records.length > input.limit
  const page = records.slice(0, input.limit)
  const last = page.at(-1)
  return {
    announcements: page.map(shapeAnnouncementAdminListItem),
    nextCursor:
      hasMore && last
        ? encodeAnnouncementAdminCursor({ updatedAt: last.updatedAt, id: last._id.toString() })
        : null,
  }
}

export const getAdminAnnouncement = async (
  id: string,
  repository: AnnouncementDraftAdminRepository = mongooseRepository,
) => {
  const record = await repository.findById(id)
  if (!record) throw notFound()
  return shapeAnnouncementAdminDetail(record)
}

export const createAnnouncementDraft = async (
  input: AnnouncementCreateRequest,
  repository: AnnouncementDraftAdminRepository = mongooseRepository,
) => {
  const candidate = {
    category: input.category,
    priority: input.priority,
    publicationStatus: 'draft',
    governanceStatus: 'normal',
    revision: 0,
  } as const
  const validation = validateAnnouncementDraft(candidate)
  if (!validation.valid) throw draftInvalid(validation.issues)
  const created = await repository.create(candidate)
  return shapeAnnouncementAdminDetail(created)
}

export const saveAnnouncementDraft = async (
  id: string,
  input: AnnouncementSaveRequest,
  repository: AnnouncementDraftAdminRepository = mongooseRepository,
) => {
  const candidate = {
    category: input.category,
    priority: input.priority,
    ...(Object.hasOwn(input, 'title') ? { title: input.title } : {}),
    ...(Object.hasOwn(input, 'body') ? { body: input.body } : {}),
    ...(Object.hasOwn(input, 'maintenance') ? { maintenance: input.maintenance } : {}),
    publicationStatus: 'draft',
    governanceStatus: 'normal',
    revision: input.expectedRevision,
  } as const
  const validation = validateAnnouncementDraft(candidate)
  if (!validation.valid) throw draftInvalid(validation.issues)

  const $set: Record<string, unknown> = { category: input.category, priority: input.priority }
  const $unset: Record<string, ''> = {}
  for (const field of ['title', 'body', 'maintenance'] as const) {
    if (Object.hasOwn(input, field)) $set[field] = input[field]
    else $unset[field] = ''
  }
  const update: UpdateQuery<IAnnouncement> = {
    $set,
    $inc: { revision: 1 },
    ...(Object.keys($unset).length > 0 ? { $unset } : {}),
  }
  const filter: QueryFilter<IAnnouncement> = {
    _id: id,
    revision: input.expectedRevision,
    publicationStatus: 'draft',
    governanceStatus: 'normal',
  }
  const saved = await repository.save(filter, update)
  if (!saved) return classifyFailedMutation(id, input.expectedRevision, repository)
  return shapeAnnouncementAdminDetail(saved)
}

export const deleteAnnouncementDraft = async (
  id: string,
  expectedRevision: number,
  repository: AnnouncementDraftAdminRepository = mongooseRepository,
) => {
  const filter: QueryFilter<IAnnouncement> = {
    _id: id,
    revision: expectedRevision,
    publicationStatus: 'draft',
    governanceStatus: 'normal',
  }
  if (!(await repository.delete(filter))) {
    return classifyFailedMutation(id, expectedRevision, repository)
  }
  return { deleted: true as const, id }
}
