import { Schema, model, type Types } from 'mongoose'
import { CASE_STATES, type CaseState } from '../policies/caseLifecyclePolicy.js'

export const CASE_GOVERNANCE_ACTIONS = ['review_started', 'review_completed'] as const
export type CaseGovernanceAction = (typeof CASE_GOVERNANCE_ACTIONS)[number]

export interface ICaseGovernanceEvent {
  caseId: Types.ObjectId
  reportId: Types.ObjectId
  actorUserId: Types.ObjectId
  action: CaseGovernanceAction
  occurredAt: Date
  outcome: 'succeeded'
  fromState: CaseState
  toState: CaseState
  fromRevision: number
  toRevision: number
  operationId: string
  commandDigest: string
  decisionId?: Types.ObjectId
  createdAt: Date
}

const safeRevision = (value: number) => Number.isSafeInteger(value) && value >= 0

const caseGovernanceEventSchema = new Schema<ICaseGovernanceEvent>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'ReviewCase', required: true, immutable: true },
    reportId: { type: Schema.Types.ObjectId, ref: 'Report', required: true, immutable: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    action: { type: String, enum: CASE_GOVERNANCE_ACTIONS, required: true, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
    outcome: { type: String, enum: ['succeeded'], required: true, immutable: true },
    fromState: { type: String, enum: CASE_STATES, required: true, immutable: true },
    toState: { type: String, enum: CASE_STATES, required: true, immutable: true },
    fromRevision: { type: Number, required: true, immutable: true, validate: safeRevision },
    toRevision: { type: Number, required: true, immutable: true, validate: safeRevision },
    operationId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 1,
      maxlength: 128,
      match: /^[a-z0-9][a-z0-9._:-]*$/,
    },
    commandDigest: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    decisionId: {
      type: Schema.Types.ObjectId,
      ref: 'FinalReviewDecision',
      immutable: true,
      required: function (this: ICaseGovernanceEvent) {
        return this.action === 'review_completed'
      },
      validate: {
        validator: function (this: ICaseGovernanceEvent, value: Types.ObjectId | undefined) {
          return this.action === 'review_completed' ? value !== undefined : value === undefined
        },
        message: 'decisionId is valid only for review_completed',
      },
    } as never,
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    strictQuery: 'throw',
    autoIndex: false,
    autoCreate: false,
    collection: 'casegovernanceevents',
  },
)

caseGovernanceEventSchema.index(
  { operationId: 1 },
  { unique: true, name: 'case_event_operation_unique' },
)

caseGovernanceEventSchema.pre('validate', function () {
  const validStart =
    this.action === 'review_started' &&
    this.fromState === 'needs_review' &&
    this.toState === 'under_review' &&
    this.fromRevision === 0 &&
    this.toRevision === 1 &&
    this.decisionId === undefined
  const validCompletion =
    this.action === 'review_completed' &&
    this.fromState === 'under_review' &&
    this.toState === 'review_completed' &&
    this.fromRevision === 1 &&
    this.toRevision === 2 &&
    this.decisionId !== undefined
  if (!validStart && !validCompletion) {
    this.invalidate('action', 'Case governance transition metadata is inconsistent')
  }
})
caseGovernanceEventSchema.index(
  { caseId: 1, action: 1 },
  { unique: true, name: 'case_event_action_unique' },
)
caseGovernanceEventSchema.index(
  { caseId: 1, occurredAt: 1, _id: 1 },
  { name: 'case_event_case_history' },
)
caseGovernanceEventSchema.index(
  { reportId: 1, occurredAt: 1, _id: 1 },
  { name: 'case_event_report_history' },
)

export const CASE_GOVERNANCE_EVENT_IMMUTABLE_MESSAGE =
  'Case governance events are append-only and cannot be mutated'

const rejectMutation = () => {
  throw new Error(CASE_GOVERNANCE_EVENT_IMMUTABLE_MESSAGE)
}

caseGovernanceEventSchema.pre('updateOne', rejectMutation)
caseGovernanceEventSchema.pre('updateMany', rejectMutation)
caseGovernanceEventSchema.pre('findOneAndUpdate', rejectMutation)
caseGovernanceEventSchema.pre('replaceOne', rejectMutation)
caseGovernanceEventSchema.pre('findOneAndReplace', rejectMutation)
caseGovernanceEventSchema.pre('deleteOne', { document: false, query: true }, rejectMutation)
caseGovernanceEventSchema.pre('deleteOne', { document: true, query: false }, rejectMutation)
caseGovernanceEventSchema.pre('deleteMany', rejectMutation)
caseGovernanceEventSchema.pre('findOneAndDelete', rejectMutation)
caseGovernanceEventSchema.pre('bulkWrite', function (operations) {
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
caseGovernanceEventSchema.pre('save', function () {
  if (!this.isNew && this.isModified()) rejectMutation()
})

export const CaseGovernanceEvent = model<ICaseGovernanceEvent>(
  'CaseGovernanceEvent',
  caseGovernanceEventSchema,
)
