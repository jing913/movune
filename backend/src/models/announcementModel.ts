import { Schema, model } from 'mongoose'
import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_GOVERNANCE_STATUSES,
  ANNOUNCEMENT_MAINTENANCE_STATUSES,
  ANNOUNCEMENT_PRIORITIES,
  ANNOUNCEMENT_PUBLICATION_STATUSES,
  type AnnouncementCategory,
  type AnnouncementGovernanceStatus,
  type AnnouncementMaintenanceData,
  type AnnouncementPriority,
  type AnnouncementPublicationStatus,
} from '../policies/announcementLifecyclePolicy.js'
import {
  isAnnouncementRichText,
  type AnnouncementRichTextDocument,
} from '../utils/announcementRichText.js'

export type AnnouncementImportantUpdate = Readonly<{
  at: Date
  note: string
}>

export interface IAnnouncement {
  category: AnnouncementCategory
  priority: AnnouncementPriority
  title: string
  body: AnnouncementRichTextDocument
  publicationStatus: AnnouncementPublicationStatus
  governanceStatus: AnnouncementGovernanceStatus
  publishedAt?: Date
  importantUpdate?: AnnouncementImportantUpdate
  maintenance?: AnnouncementMaintenanceData
  revision: number
  createdAt: Date
  updatedAt: Date
}

const nonemptyTrimmedText = {
  validator: (value: string) => value.length > 0 && value === value.trim(),
  message: 'Value must be non-empty and trimmed',
} as const

const importantUpdateSchema = new Schema<AnnouncementImportantUpdate>(
  {
    at: { type: Date, required: true },
    note: { type: String, required: true, validate: nonemptyTrimmedText },
  },
  { _id: false },
)

const maintenanceSchema = new Schema<AnnouncementMaintenanceData>(
  {
    status: { type: String, enum: ANNOUNCEMENT_MAINTENANCE_STATUSES, required: true },
    startsAt: { type: Date, required: true },
    endsAt: {
      type: Date,
      required: true,
      validate: {
        validator: function (this: unknown, value: Date) {
          const context = this as { startsAt?: unknown }
          return (
            value instanceof Date && context.startsAt instanceof Date && context.startsAt < value
          )
        },
        message: 'endsAt must follow startsAt',
      },
    },
    affectedAreas: {
      type: [String],
      required: true,
      validate: {
        validator: (value: string[]) =>
          value.length > 0 && value.every((area) => area.length > 0 && area === area.trim()),
        message: 'affectedAreas must contain user-understandable product areas',
      },
    },
    expectedImpact: { type: String, required: true, validate: nonemptyTrimmedText },
    actualCompletionTime: {
      type: Date,
      required: function (this: unknown) {
        return (this as { status?: unknown }).status === 'completed'
      },
      validate: {
        validator: function (this: unknown, value: Date | undefined) {
          return (this as { status?: unknown }).status === 'completed' || value === undefined
        },
        message: 'actualCompletionTime is only supported for completed maintenance',
      },
    },
  },
  { _id: false },
)

const announcementSchema = new Schema<IAnnouncement>(
  {
    category: { type: String, enum: ANNOUNCEMENT_CATEGORIES, required: true },
    priority: { type: String, enum: ANNOUNCEMENT_PRIORITIES, required: true },
    title: { type: String, required: true, validate: nonemptyTrimmedText },
    body: {
      type: Schema.Types.Mixed,
      required: true,
      validate: {
        validator: isAnnouncementRichText,
        message: 'body must satisfy the Movune Announcement Rich Text contract',
      },
    },
    publicationStatus: {
      type: String,
      enum: ANNOUNCEMENT_PUBLICATION_STATUSES,
      required: true,
    },
    governanceStatus: {
      type: String,
      enum: ANNOUNCEMENT_GOVERNANCE_STATUSES,
      required: true,
    },
    publishedAt: { type: Date },
    importantUpdate: { type: importantUpdateSchema },
    maintenance: {
      type: maintenanceSchema,
      required: function (this: IAnnouncement) {
        return this.category === 'system_maintenance'
      },
      validate: {
        validator: function (this: IAnnouncement, value: AnnouncementMaintenanceData | undefined) {
          return this.category === 'system_maintenance' || value === undefined
        },
        message: 'maintenance is only supported for system_maintenance Announcements',
      },
    },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'revision must be an integer' },
    },
  },
  { timestamps: true },
)

export const Announcement = model<IAnnouncement>('Announcement', announcementSchema)
