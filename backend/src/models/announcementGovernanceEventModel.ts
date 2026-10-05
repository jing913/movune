import { Schema, model, type ClientSession, type Types } from 'mongoose'
import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_MAINTENANCE_STATUSES,
  ANNOUNCEMENT_PRIORITIES,
  type AnnouncementCategory,
  type AnnouncementMaintenanceStatus,
  type AnnouncementPriority,
} from '../policies/announcementLifecyclePolicy.js'

export const ANNOUNCEMENT_GOVERNANCE_ACTIONS = [
  'publish',
  'published_edit',
  'important_update',
  'withdraw',
  'restore',
  'maintenance_transition',
] as const

export type AnnouncementGovernanceAction = (typeof ANNOUNCEMENT_GOVERNANCE_ACTIONS)[number]

export type AnnouncementGovernanceChanges = Readonly<{
  fields?: readonly string[]
  category?: Readonly<{ from: AnnouncementCategory; to: AnnouncementCategory }>
  priority?: Readonly<{ from: AnnouncementPriority; to: AnnouncementPriority }>
  maintenanceStatus?: Readonly<{
    from: AnnouncementMaintenanceStatus
    to: AnnouncementMaintenanceStatus
  }>
}>

export interface IAnnouncementGovernanceEvent {
  announcementId: Types.ObjectId
  actorUserId: Types.ObjectId
  action: AnnouncementGovernanceAction
  occurredAt: Date
  outcome: 'succeeded'
  changes?: AnnouncementGovernanceChanges
  updateNote?: string
  createdAt: Date
}

export type AnnouncementGovernanceEventWrite = Omit<IAnnouncementGovernanceEvent, 'createdAt'>

const ANNOUNCEMENT_GOVERNANCE_CHANGE_FIELDS = [
  'category',
  'priority',
  'title',
  'body',
  'maintenance.status',
  'maintenance.startsAt',
  'maintenance.endsAt',
  'maintenance.affectedAreas',
  'maintenance.expectedImpact',
  'maintenance.actualCompletionTime',
] as const

const categoryChangeSchema = new Schema(
  {
    from: { type: String, enum: ANNOUNCEMENT_CATEGORIES, required: true, immutable: true },
    to: { type: String, enum: ANNOUNCEMENT_CATEGORIES, required: true, immutable: true },
  },
  { _id: false },
)

const priorityChangeSchema = new Schema(
  {
    from: { type: String, enum: ANNOUNCEMENT_PRIORITIES, required: true, immutable: true },
    to: { type: String, enum: ANNOUNCEMENT_PRIORITIES, required: true, immutable: true },
  },
  { _id: false },
)

const maintenanceStatusChangeSchema = new Schema(
  {
    from: {
      type: String,
      enum: ANNOUNCEMENT_MAINTENANCE_STATUSES,
      required: true,
      immutable: true,
    },
    to: {
      type: String,
      enum: ANNOUNCEMENT_MAINTENANCE_STATUSES,
      required: true,
      immutable: true,
    },
  },
  { _id: false },
)

const changesSchema = new Schema(
  {
    fields: {
      type: [{ type: String, enum: ANNOUNCEMENT_GOVERNANCE_CHANGE_FIELDS }],
      default: undefined,
      immutable: true,
    },
    category: { type: categoryChangeSchema, immutable: true },
    priority: { type: priorityChangeSchema, immutable: true },
    maintenanceStatus: { type: maintenanceStatusChangeSchema, immutable: true },
  },
  { _id: false },
)

const announcementGovernanceEventSchema = new Schema(
  {
    announcementId: {
      type: Schema.Types.ObjectId,
      ref: 'Announcement',
      required: true,
      immutable: true,
    },
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    action: {
      type: String,
      enum: ANNOUNCEMENT_GOVERNANCE_ACTIONS,
      required: true,
      immutable: true,
    },
    occurredAt: { type: Date, required: true, immutable: true },
    outcome: { type: String, enum: ['succeeded'], required: true, immutable: true },
    changes: { type: changesSchema, immutable: true },
    updateNote: {
      type: String,
      required: function (this: IAnnouncementGovernanceEvent) {
        return this.action === 'important_update'
      },
      immutable: true,
      validate: {
        validator: function (this: IAnnouncementGovernanceEvent, value: string | undefined) {
          return this.action === 'important_update'
            ? value !== undefined && value.length > 0 && value === value.trim()
            : value === undefined
        },
        message: 'updateNote is only valid for important_update and must be non-empty and trimmed',
      },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

announcementGovernanceEventSchema.index({ announcementId: 1, occurredAt: 1, _id: 1 })

export const ANNOUNCEMENT_GOVERNANCE_EVENT_IMMUTABLE_MESSAGE =
  'Announcement governance events are append-only and cannot be mutated'

const rejectMutation = () => {
  throw new Error(ANNOUNCEMENT_GOVERNANCE_EVENT_IMMUTABLE_MESSAGE)
}

announcementGovernanceEventSchema.pre('updateOne', rejectMutation)
announcementGovernanceEventSchema.pre('updateMany', rejectMutation)
announcementGovernanceEventSchema.pre('findOneAndUpdate', rejectMutation)
announcementGovernanceEventSchema.pre('replaceOne', rejectMutation)
announcementGovernanceEventSchema.pre('findOneAndReplace', rejectMutation)
announcementGovernanceEventSchema.pre('deleteOne', { document: false, query: true }, rejectMutation)
announcementGovernanceEventSchema.pre('deleteOne', { document: true, query: false }, rejectMutation)
announcementGovernanceEventSchema.pre('deleteMany', rejectMutation)
announcementGovernanceEventSchema.pre('findOneAndDelete', rejectMutation)
announcementGovernanceEventSchema.pre('bulkWrite', function (operations) {
  if (
    operations.some(
      (operation) =>
        'updateOne' in operation ||
        'updateMany' in operation ||
        'replaceOne' in operation ||
        'deleteOne' in operation ||
        'deleteMany' in operation,
    )
  ) {
    rejectMutation()
  }
})
announcementGovernanceEventSchema.pre('save', function () {
  if (!this.isNew && this.isModified()) rejectMutation()
})

const AnnouncementGovernanceEventModel = model<IAnnouncementGovernanceEvent>(
  'AnnouncementGovernanceEvent',
  announcementGovernanceEventSchema,
)

export const appendAnnouncementGovernanceEvent = async (
  input: AnnouncementGovernanceEventWrite,
  session: ClientSession,
): Promise<void> => {
  await AnnouncementGovernanceEventModel.create([input], { session })
}
