import { Schema, Types, model, type mongo } from 'mongoose'

export const REPORT_EVIDENCE_ACCESS_AUDIT_EVENT_TYPES = ['report_evidence_access_attempt'] as const

export const REPORT_EVIDENCE_ACCESS_AUDIT_OUTCOMES = ['attempt_initiated'] as const

export type ReportEvidenceAccessAuditEventType =
  (typeof REPORT_EVIDENCE_ACCESS_AUDIT_EVENT_TYPES)[number]
export type ReportEvidenceAccessAuditOutcome =
  (typeof REPORT_EVIDENCE_ACCESS_AUDIT_OUTCOMES)[number]

export interface IReportEvidenceAccessAuditEvent {
  actorUserId: Types.ObjectId
  reportId: Types.ObjectId
  evidenceMessageId: Types.ObjectId
  eventType: ReportEvidenceAccessAuditEventType
  attemptedAt: Date
  outcome: ReportEvidenceAccessAuditOutcome
}

export type ReportEvidenceAccessAuditEventWrite = IReportEvidenceAccessAuditEvent

export type ReportEvidenceAuditWriteOptions = Readonly<{
  writeConcern: mongo.WriteConcern
  timeoutMS: number
}>

export type ReportEvidenceAuditInsertAcknowledgment = Readonly<{
  acknowledged: boolean
  insertedId?: Types.ObjectId
}>

const reportEvidenceAccessAuditEventSchema = new Schema<IReportEvidenceAccessAuditEvent>(
  {
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    reportId: {
      type: Schema.Types.ObjectId,
      ref: 'Report',
      required: true,
      immutable: true,
    },
    evidenceMessageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
      required: true,
      immutable: true,
    },
    eventType: {
      type: String,
      enum: REPORT_EVIDENCE_ACCESS_AUDIT_EVENT_TYPES,
      required: true,
      immutable: true,
    },
    attemptedAt: { type: Date, required: true, immutable: true },
    outcome: {
      type: String,
      enum: REPORT_EVIDENCE_ACCESS_AUDIT_OUTCOMES,
      required: true,
      immutable: true,
    },
  },
  {
    strict: 'throw',
    versionKey: false,
  },
)

export const REPORT_EVIDENCE_ACCESS_AUDIT_IMMUTABLE_MESSAGE =
  'Report evidence access audit events are append-only and cannot be mutated'

const rejectMutation = () => {
  throw new Error(REPORT_EVIDENCE_ACCESS_AUDIT_IMMUTABLE_MESSAGE)
}

reportEvidenceAccessAuditEventSchema.pre('updateOne', rejectMutation)
reportEvidenceAccessAuditEventSchema.pre('updateMany', rejectMutation)
reportEvidenceAccessAuditEventSchema.pre('findOneAndUpdate', rejectMutation)
reportEvidenceAccessAuditEventSchema.pre('replaceOne', rejectMutation)
reportEvidenceAccessAuditEventSchema.pre('findOneAndReplace', rejectMutation)
reportEvidenceAccessAuditEventSchema.pre(
  'deleteOne',
  { document: false, query: true },
  rejectMutation,
)
reportEvidenceAccessAuditEventSchema.pre(
  'deleteOne',
  { document: true, query: false },
  rejectMutation,
)
reportEvidenceAccessAuditEventSchema.pre('deleteMany', rejectMutation)
reportEvidenceAccessAuditEventSchema.pre('findOneAndDelete', rejectMutation)
reportEvidenceAccessAuditEventSchema.pre('bulkWrite', function (operations) {
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
reportEvidenceAccessAuditEventSchema.pre('save', function () {
  if (!this.isNew && this.isModified()) rejectMutation()
})

export const ReportEvidenceAccessAuditEventModel = model<IReportEvidenceAccessAuditEvent>(
  'ReportEvidenceAccessAuditEvent',
  reportEvidenceAccessAuditEventSchema,
)

export const appendReportEvidenceAccessAuditEvent = async (
  input: ReportEvidenceAccessAuditEventWrite,
  options: ReportEvidenceAuditWriteOptions,
): Promise<ReportEvidenceAuditInsertAcknowledgment> => {
  const document = new ReportEvidenceAccessAuditEventModel(input)
  await document.validate()
  const result = await ReportEvidenceAccessAuditEventModel.collection.insertOne(
    document.toObject(),
    options,
  )
  return { acknowledged: result.acknowledged, insertedId: result.insertedId }
}
