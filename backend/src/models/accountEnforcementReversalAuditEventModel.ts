import { Schema, model, type Types, type mongo } from 'mongoose'

export const ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_EVENT_TYPES = [
  'started',
  'denied',
  'failed',
  'unconfirmed',
] as const

export type AccountEnforcementReversalAuditEventType =
  (typeof ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_EVENT_TYPES)[number]

export interface IAccountEnforcementReversalAuditEvent {
  attemptId: Types.ObjectId
  actorUserId: Types.ObjectId
  decisionId: Types.ObjectId
  operationId: string
  eventType: AccountEnforcementReversalAuditEventType
  occurredAt: Date
  failureCode?: string
}

export type AccountEnforcementReversalAuditWriteOptions = Readonly<{
  writeConcern: mongo.WriteConcern
  timeoutMS: number
}>

const schema = new Schema<IAccountEnforcementReversalAuditEvent>(
  {
    attemptId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    decisionId: {
      type: Schema.Types.ObjectId,
      ref: 'AccountEnforcementAction',
      required: true,
      immutable: true,
    },
    operationId: {
      type: String,
      required: true,
      immutable: true,
      minlength: 1,
      maxlength: 128,
      match: /^[a-z0-9][a-z0-9._:-]*$/,
    },
    eventType: {
      type: String,
      enum: ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_EVENT_TYPES,
      required: true,
      immutable: true,
    },
    occurredAt: { type: Date, required: true, immutable: true },
    failureCode: {
      type: String,
      immutable: true,
      maxlength: 128,
      match: /^[A-Z0-9_]+$/,
      required: function (this: IAccountEnforcementReversalAuditEvent) {
        return this.eventType !== 'started'
      },
      validate: {
        validator: function (
          this: IAccountEnforcementReversalAuditEvent,
          value: string | undefined,
        ) {
          return this.eventType === 'started' ? value === undefined : value !== undefined
        },
        message: 'failureCode is required only for terminal reversal audit events',
      },
    } as never,
  },
  {
    strict: 'throw',
    versionKey: false,
    autoCreate: false,
    autoIndex: false,
    collection: 'accountenforcementreversalauditevents',
  },
)

schema.index(
  { attemptId: 1, eventType: 1 },
  { unique: true, name: 'reversal_audit_attempt_event_unique' },
)
schema.index({ actorUserId: 1, occurredAt: 1, _id: 1 }, { name: 'reversal_audit_actor_history' })

export const ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_IMMUTABLE_MESSAGE =
  'Account enforcement reversal audit events are append-only and cannot be mutated'

const rejectMutation = () => {
  throw new Error(ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_IMMUTABLE_MESSAGE)
}

schema.pre('updateOne', rejectMutation)
schema.pre('updateMany', rejectMutation)
schema.pre('findOneAndUpdate', rejectMutation)
schema.pre('replaceOne', rejectMutation)
schema.pre('findOneAndReplace', rejectMutation)
schema.pre('deleteOne', { document: false, query: true }, rejectMutation)
schema.pre('deleteOne', { document: true, query: false }, rejectMutation)
schema.pre('deleteMany', rejectMutation)
schema.pre('findOneAndDelete', rejectMutation)
schema.pre('bulkWrite', function (operations) {
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
schema.pre('save', function () {
  if (!this.isNew && this.isModified()) rejectMutation()
})

export const AccountEnforcementReversalAuditEvent = model<IAccountEnforcementReversalAuditEvent>(
  'AccountEnforcementReversalAuditEvent',
  schema,
)

export const appendAccountEnforcementReversalAuditEvent = async (
  input: IAccountEnforcementReversalAuditEvent,
  options: AccountEnforcementReversalAuditWriteOptions,
) => {
  const document = new AccountEnforcementReversalAuditEvent(input)
  await document.validate()
  const result = await AccountEnforcementReversalAuditEvent.collection.insertOne(
    document.toObject(),
    options,
  )
  return { acknowledged: result.acknowledged, insertedId: result.insertedId }
}
