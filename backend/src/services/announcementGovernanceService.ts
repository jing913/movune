import mongoose, { Types, type ClientSession, type QueryFilter, type UpdateQuery } from 'mongoose'
import { Announcement, type IAnnouncement } from '../models/announcementModel.js'
import {
  appendAnnouncementGovernanceEvent,
  type AnnouncementGovernanceAction,
  type AnnouncementGovernanceChanges,
  type AnnouncementGovernanceEventWrite,
} from '../models/announcementGovernanceEventModel.js'
import {
  canTransitionAnnouncementCategory,
  canTransitionAnnouncementMaintenance,
  canTransitionAnnouncementPublication,
  type AnnouncementCategory,
  type AnnouncementMaintenanceData,
} from '../policies/announcementLifecyclePolicy.js'
import {
  validateAnnouncementForPublication,
  type AnnouncementValidationIssue,
} from '../policies/announcementValidationPolicy.js'
import {
  shapeAnnouncementAdminDetail,
  type AnnouncementAdminRecord,
} from './announcementDraftAdminService.js'
import {
  announcementGovernanceNotFound,
  announcementGovernanceRevisionConflict,
  announcementGovernanceStateConflict,
  announcementGovernanceTransactionFailed,
  deriveAnnouncementGovernanceChanges,
  type AnnouncementHistoricalPublishRequest,
  type AnnouncementMaintenanceTransitionRequest,
  type AnnouncementPublishedEditRequest,
  type AnnouncementRemovalRequest,
  type AnnouncementRevisionRequest,
} from '../utils/announcementGovernancePolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

const ADMIN_FIELDS =
  'category priority title body publicationStatus governanceStatus publishedAt effectiveAt effectiveAtBasis importantUpdate maintenance revision createdAt updatedAt'

export type AnnouncementGovernanceRepository = Readonly<{
  findById(id: string, session: ClientSession): Promise<AnnouncementAdminRecord | null>
  mutate(
    filter: QueryFilter<IAnnouncement>,
    update: UpdateQuery<IAnnouncement>,
    session: ClientSession,
  ): Promise<AnnouncementAdminRecord | null>
  createEvent(value: AnnouncementGovernanceEventWrite, session: ClientSession): Promise<void>
}>

type TransactionRunner = <Result>(
  operation: (session: ClientSession) => Promise<Result>,
) => Promise<Result>

export type AnnouncementGovernanceDependencies = Readonly<{
  repository?: AnnouncementGovernanceRepository
  transactionRunner?: TransactionRunner
  now?: () => Date
}>

const mongooseRepository: AnnouncementGovernanceRepository = {
  async findById(id, session) {
    return (await Announcement.findById(id)
      .select(ADMIN_FIELDS)
      .session(session)
      .lean()) as unknown as AnnouncementAdminRecord | null
  },
  async mutate(filter, update, session) {
    return (await Announcement.findOneAndUpdate(filter, update, {
      returnDocument: 'after',
      session,
    })
      .select(ADMIN_FIELDS)
      .lean()) as unknown as AnnouncementAdminRecord | null
  },
  async createEvent(value, session) {
    await appendAnnouncementGovernanceEvent(value, session)
  },
}

const defaultTransactionRunner: TransactionRunner = (operation) =>
  mongoose.connection.transaction(operation)

const publicationInvalid = (issues: readonly AnnouncementValidationIssue[]) =>
  new ApiProblem(400, 'ANNOUNCEMENT_PUBLICATION_INVALID', 'Announcement publication is invalid', {
    issues,
  })

const assertPublicationValid = (candidate: AnnouncementAdminRecord | Record<string, unknown>) => {
  const validation = validateAnnouncementForPublication(candidate)
  if (!validation.valid) throw publicationInvalid(validation.issues)
}

const isPublishedNormal = (record: AnnouncementAdminRecord) =>
  record.publicationStatus === 'published' && record.governanceStatus === 'normal'

const isDraftNormal = (record: AnnouncementAdminRecord) =>
  record.publicationStatus === 'draft' && record.governanceStatus === 'normal'

const hasHistoricalMetadata = (record: AnnouncementAdminRecord) =>
  record.effectiveAt !== undefined || record.effectiveAtBasis !== undefined

const isDraftNormalWithoutHistoricalMetadata = (record: AnnouncementAdminRecord) =>
  isDraftNormal(record) && !hasHistoricalMetadata(record)

const isWithdrawnNormal = (record: AnnouncementAdminRecord) =>
  record.publicationStatus === 'withdrawn' && record.governanceStatus === 'normal'

const isGovernanceNormal = (record: AnnouncementAdminRecord) => record.governanceStatus === 'normal'

const classifyFailedMutation = async (
  id: string,
  expectedRevision: number,
  session: ClientSession,
  repository: AnnouncementGovernanceRepository,
  hasExpectedState: (record: AnnouncementAdminRecord) => boolean,
): Promise<never> => {
  const current = await repository.findById(id, session)
  if (!current) throw announcementGovernanceNotFound()
  if (!hasExpectedState(current)) throw announcementGovernanceStateConflict()
  if (current.revision !== expectedRevision) throw announcementGovernanceRevisionConflict()
  throw announcementGovernanceStateConflict()
}

const eventWrite = (
  announcementId: string,
  actorUserId: string,
  action: AnnouncementGovernanceAction,
  occurredAt: Date,
  changes?: AnnouncementGovernanceChanges,
  updateNote?: string,
  removalReason?: Pick<AnnouncementRemovalRequest, 'reasonCode' | 'reasonSummary'>,
): AnnouncementGovernanceEventWrite => ({
  announcementId: new Types.ObjectId(announcementId),
  actorUserId: new Types.ObjectId(actorUserId),
  action,
  occurredAt,
  outcome: 'succeeded',
  ...(changes ? { changes } : {}),
  ...(updateNote !== undefined ? { updateNote } : {}),
  ...(removalReason ?? {}),
})

export const createAnnouncementGovernanceService = (
  dependencies: AnnouncementGovernanceDependencies = {},
) => {
  const repository = dependencies.repository ?? mongooseRepository
  const transactionRunner = dependencies.transactionRunner ?? defaultTransactionRunner
  const now = dependencies.now ?? (() => new Date())

  const transact = async <Result>(operation: (session: ClientSession) => Promise<Result>) => {
    try {
      return await transactionRunner(operation)
    } catch (error) {
      if (error instanceof ApiProblem) throw error
      throw announcementGovernanceTransactionFailed()
    }
  }

  return {
    publish(id: string, actorUserId: string, input: AnnouncementRevisionRequest) {
      return transact(async (session) => {
        const current = await repository.findById(id, session)
        if (!current) throw announcementGovernanceNotFound()
        if (!isDraftNormalWithoutHistoricalMetadata(current)) {
          throw announcementGovernanceStateConflict()
        }
        if (!canTransitionAnnouncementPublication('draft', 'published', current.governanceStatus)) {
          throw announcementGovernanceStateConflict()
        }
        assertPublicationValid(current)
        const occurredAt = now()
        const updated = await repository.mutate(
          {
            _id: id,
            revision: input.expectedRevision,
            publicationStatus: 'draft',
            governanceStatus: 'normal',
            effectiveAt: { $exists: false },
            effectiveAtBasis: { $exists: false },
          },
          {
            $set: { publicationStatus: 'published', publishedAt: occurredAt },
            $inc: { revision: 1 },
          },
          session,
        )
        if (!updated) {
          return classifyFailedMutation(
            id,
            input.expectedRevision,
            session,
            repository,
            isDraftNormalWithoutHistoricalMetadata,
          )
        }
        await repository.createEvent(eventWrite(id, actorUserId, 'publish', occurredAt), session)
        return shapeAnnouncementAdminDetail(updated)
      })
    },

    historicalPublish(
      id: string,
      actorUserId: string,
      input: AnnouncementHistoricalPublishRequest,
    ) {
      return transact(async (session) => {
        const current = await repository.findById(id, session)
        if (!current) throw announcementGovernanceNotFound()
        if (!isDraftNormalWithoutHistoricalMetadata(current)) {
          throw announcementGovernanceStateConflict()
        }
        if (!canTransitionAnnouncementPublication('draft', 'published', current.governanceStatus)) {
          throw announcementGovernanceStateConflict()
        }
        assertPublicationValid(current)

        const occurredAt = now()
        const updated = await repository.mutate(
          {
            _id: id,
            revision: input.expectedRevision,
            publicationStatus: 'draft',
            governanceStatus: 'normal',
            effectiveAt: { $exists: false },
            effectiveAtBasis: { $exists: false },
          },
          {
            $set: {
              publicationStatus: 'published',
              publishedAt: occurredAt,
              effectiveAt: input.effectiveAt,
              effectiveAtBasis: input.effectiveAtBasis,
            },
            $inc: { revision: 1 },
          },
          session,
        )
        if (!updated) {
          return classifyFailedMutation(
            id,
            input.expectedRevision,
            session,
            repository,
            isDraftNormalWithoutHistoricalMetadata,
          )
        }
        await repository.createEvent(
          eventWrite(id, actorUserId, 'historical_publish', occurredAt),
          session,
        )
        return shapeAnnouncementAdminDetail(updated)
      })
    },

    editPublished(id: string, actorUserId: string, input: AnnouncementPublishedEditRequest) {
      return transact(async (session) => {
        const current = await repository.findById(id, session)
        if (!current) throw announcementGovernanceNotFound()
        if (!isPublishedNormal(current)) throw announcementGovernanceStateConflict()

        const candidate = {
          category: input.category,
          priority: input.priority,
          title: input.title,
          body: input.body,
          ...(Object.hasOwn(input, 'maintenance') ? { maintenance: input.maintenance } : {}),
          publicationStatus: 'published',
          governanceStatus: 'normal',
          revision: input.expectedRevision,
          ...(current.effectiveAt !== undefined ? { effectiveAt: current.effectiveAt } : {}),
          ...(current.effectiveAtBasis !== undefined
            ? { effectiveAtBasis: current.effectiveAtBasis }
            : {}),
        }
        assertPublicationValid(candidate)

        if (current.category !== input.category) {
          if (
            !canTransitionAnnouncementCategory({
              from: current.category,
              to: input.category as AnnouncementCategory,
              ...(current.maintenance
                ? { currentMaintenance: current.maintenance as AnnouncementMaintenanceData }
                : {}),
              ...(input.maintenance
                ? { nextMaintenance: input.maintenance as AnnouncementMaintenanceData }
                : {}),
              governanceStatus: current.governanceStatus,
            })
          ) {
            throw announcementGovernanceStateConflict()
          }
        } else if (
          current.category === 'system_maintenance' &&
          current.maintenance?.status !==
            (input.maintenance as AnnouncementMaintenanceData | undefined)?.status
        ) {
          throw announcementGovernanceStateConflict()
        }

        const occurredAt = now()
        const $set: Record<string, unknown> = {
          category: input.category,
          priority: input.priority,
          title: input.title,
          body: input.body,
          ...(Object.hasOwn(input, 'maintenance') ? { maintenance: input.maintenance } : {}),
          ...(input.editIntent === 'important_update'
            ? { importantUpdate: { at: occurredAt, note: input.updateNote } }
            : {}),
        }
        const update: UpdateQuery<IAnnouncement> = {
          $set,
          $inc: { revision: 1 },
          ...(!Object.hasOwn(input, 'maintenance') ? { $unset: { maintenance: '' } } : {}),
        }
        const updated = await repository.mutate(
          {
            _id: id,
            revision: input.expectedRevision,
            publicationStatus: 'published',
            governanceStatus: 'normal',
          },
          update,
          session,
        )
        if (!updated) {
          return classifyFailedMutation(
            id,
            input.expectedRevision,
            session,
            repository,
            isPublishedNormal,
          )
        }
        const changes = deriveAnnouncementGovernanceChanges(current, candidate)
        await repository.createEvent(
          eventWrite(
            id,
            actorUserId,
            input.editIntent === 'important_update' ? 'important_update' : 'published_edit',
            occurredAt,
            changes,
            input.updateNote,
          ),
          session,
        )
        return shapeAnnouncementAdminDetail(updated)
      })
    },

    withdraw(id: string, actorUserId: string, input: AnnouncementRevisionRequest) {
      return transact(async (session) => {
        const updated = await repository.mutate(
          {
            _id: id,
            revision: input.expectedRevision,
            publicationStatus: 'published',
            governanceStatus: 'normal',
          },
          { $set: { publicationStatus: 'withdrawn' }, $inc: { revision: 1 } },
          session,
        )
        if (!updated) {
          return classifyFailedMutation(
            id,
            input.expectedRevision,
            session,
            repository,
            isPublishedNormal,
          )
        }
        const occurredAt = now()
        await repository.createEvent(eventWrite(id, actorUserId, 'withdraw', occurredAt), session)
        return shapeAnnouncementAdminDetail(updated)
      })
    },

    restore(id: string, actorUserId: string, input: AnnouncementRevisionRequest) {
      return transact(async (session) => {
        const current = await repository.findById(id, session)
        if (!current) throw announcementGovernanceNotFound()
        if (!isWithdrawnNormal(current)) throw announcementGovernanceStateConflict()
        if (
          !canTransitionAnnouncementPublication('withdrawn', 'published', current.governanceStatus)
        ) {
          throw announcementGovernanceStateConflict()
        }
        assertPublicationValid(current)
        const updated = await repository.mutate(
          {
            _id: id,
            revision: input.expectedRevision,
            publicationStatus: 'withdrawn',
            governanceStatus: 'normal',
          },
          { $set: { publicationStatus: 'published' }, $inc: { revision: 1 } },
          session,
        )
        if (!updated) {
          return classifyFailedMutation(
            id,
            input.expectedRevision,
            session,
            repository,
            isWithdrawnNormal,
          )
        }
        const occurredAt = now()
        await repository.createEvent(eventWrite(id, actorUserId, 'restore', occurredAt), session)
        return shapeAnnouncementAdminDetail(updated)
      })
    },

    transitionMaintenance(
      id: string,
      actorUserId: string,
      input: AnnouncementMaintenanceTransitionRequest,
    ) {
      return transact(async (session) => {
        const current = await repository.findById(id, session)
        if (!current) throw announcementGovernanceNotFound()
        const currentStatus = current.maintenance?.status
        if (
          !isPublishedNormal(current) ||
          current.category !== 'system_maintenance' ||
          currentStatus === undefined ||
          !canTransitionAnnouncementMaintenance(
            currentStatus,
            input.status,
            current.governanceStatus,
          )
        ) {
          throw announcementGovernanceStateConflict()
        }
        const nextMaintenance = {
          ...current.maintenance,
          status: input.status,
          ...(input.status === 'completed'
            ? { actualCompletionTime: input.actualCompletionTime }
            : {}),
        }
        assertPublicationValid({ ...current, maintenance: nextMaintenance })
        const updated = await repository.mutate(
          {
            _id: id,
            revision: input.expectedRevision,
            publicationStatus: 'published',
            governanceStatus: 'normal',
            category: 'system_maintenance',
            'maintenance.status': currentStatus,
          },
          { $set: { maintenance: nextMaintenance }, $inc: { revision: 1 } },
          session,
        )
        if (!updated) {
          return classifyFailedMutation(
            id,
            input.expectedRevision,
            session,
            repository,
            (record) =>
              isPublishedNormal(record) &&
              record.category === 'system_maintenance' &&
              record.maintenance?.status === currentStatus,
          )
        }
        const occurredAt = now()
        await repository.createEvent(
          eventWrite(id, actorUserId, 'maintenance_transition', occurredAt, {
            fields: ['maintenance.status'],
            maintenanceStatus: { from: currentStatus, to: input.status },
          }),
          session,
        )
        return shapeAnnouncementAdminDetail(updated)
      })
    },

    remove(id: string, actorUserId: string, input: AnnouncementRemovalRequest) {
      return transact(async (session) => {
        const updated = await repository.mutate(
          {
            _id: id,
            revision: input.expectedRevision,
            governanceStatus: 'normal',
          },
          {
            $set: { governanceStatus: 'exceptionally_removed' },
            $inc: { revision: 1 },
          },
          session,
        )
        if (!updated) {
          return classifyFailedMutation(
            id,
            input.expectedRevision,
            session,
            repository,
            isGovernanceNormal,
          )
        }
        const occurredAt = now()
        await repository.createEvent(
          eventWrite(id, actorUserId, 'exceptional_removal', occurredAt, undefined, undefined, {
            reasonCode: input.reasonCode,
            reasonSummary: input.reasonSummary,
          }),
          session,
        )
        return shapeAnnouncementAdminDetail(updated)
      })
    },
  }
}

const announcementGovernanceService = createAnnouncementGovernanceService()

export const publishAnnouncement = announcementGovernanceService.publish
export const historicalPublishAnnouncement = announcementGovernanceService.historicalPublish
export const editPublishedAnnouncement = announcementGovernanceService.editPublished
export const withdrawAnnouncement = announcementGovernanceService.withdraw
export const restoreAnnouncement = announcementGovernanceService.restore
export const transitionAnnouncementMaintenance = announcementGovernanceService.transitionMaintenance
export const removeAnnouncement = announcementGovernanceService.remove
