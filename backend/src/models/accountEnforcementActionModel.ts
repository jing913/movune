import { Schema, model, type Types } from 'mongoose'
import {
  ACCOUNT_ENFORCEMENT_DECISION_TYPES,
  ENFORCEMENT_IDENTIFIER_MAX_LENGTH,
  ENFORCEMENT_IDENTIFIER_PATTERN,
  ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH,
  type AccountEnforcementDecisionType,
  type AccountEnforcementRecordType,
} from '../utils/accountEnforcementPolicy.js'

export interface IAccountEnforcementAction {
  targetUserId: Types.ObjectId
  recordType: AccountEnforcementRecordType
  effectiveAt: Date
  performedByUserId: Types.ObjectId
  reasonCode: string
  reasonSummary: string
  decisionType?: AccountEnforcementDecisionType
  guidelineRuleId?: string
  guidelineVersion?: string
  endsAt?: Date
  reversesDecisionId?: Types.ObjectId
  createdAt: Date
}

type ValidationContext = Partial<IAccountEnforcementAction>

const requiredForDecision = function (this: ValidationContext) {
  return this.recordType === 'decision'
}

const requiredForTemporarySuspension = function (this: ValidationContext) {
  return this.recordType === 'decision' && this.decisionType === 'temporary_suspension'
}

const requiredForReversal = function (this: ValidationContext) {
  return this.recordType === 'reversal'
}

const decisionOnly = function (this: ValidationContext, value: unknown) {
  return this.recordType === 'decision' || value == null
}

const reversalOnly = function (this: ValidationContext, value: unknown) {
  return this.recordType === 'reversal' || value == null
}

const validEndTime = function (this: ValidationContext, value: unknown) {
  if (this.recordType !== 'decision' || this.decisionType !== 'temporary_suspension') {
    return value == null
  }
  return value instanceof Date && this.effectiveAt instanceof Date && value > this.effectiveAt
}

const identifierField = {
  type: String,
  required: true,
  immutable: true,
  trim: true,
  maxlength: ENFORCEMENT_IDENTIFIER_MAX_LENGTH,
  match: ENFORCEMENT_IDENTIFIER_PATTERN,
} as const

const accountEnforcementActionSchema = new Schema(
  {
    targetUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    recordType: {
      type: String,
      enum: ['decision', 'reversal'],
      required: true,
      immutable: true,
    },
    effectiveAt: { type: Date, required: true, immutable: true },
    performedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    reasonCode: identifierField,
    reasonSummary: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      validate: {
        validator: (value: string) =>
          value.length > 0 && [...value].length <= ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH,
        message: `reasonSummary cannot exceed ${ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH} characters`,
      },
    },
    decisionType: {
      type: String,
      enum: ACCOUNT_ENFORCEMENT_DECISION_TYPES,
      required: requiredForDecision,
      immutable: true,
      validate: {
        validator: decisionOnly,
        message: 'decisionType is only supported for decisions',
      },
    },
    guidelineRuleId: {
      ...identifierField,
      required: requiredForDecision,
      validate: {
        validator: decisionOnly,
        message: 'guidelineRuleId is only supported for decisions',
      },
    },
    guidelineVersion: {
      ...identifierField,
      required: requiredForDecision,
      validate: {
        validator: decisionOnly,
        message: 'guidelineVersion is only supported for decisions',
      },
    },
    endsAt: {
      type: Date,
      required: requiredForTemporarySuspension,
      immutable: true,
      validate: {
        validator: validEndTime,
        message: 'endsAt is only valid after the start of a temporary suspension',
      },
    },
    reversesDecisionId: {
      type: Schema.Types.ObjectId,
      ref: 'AccountEnforcementAction',
      required: requiredForReversal,
      immutable: true,
      validate: {
        validator: reversalOnly,
        message: 'reversesDecisionId is only supported for reversals',
      },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
)

accountEnforcementActionSchema.index({ targetUserId: 1, effectiveAt: 1, _id: 1 })
accountEnforcementActionSchema.index(
  { reversesDecisionId: 1 },
  {
    unique: true,
    partialFilterExpression: { recordType: 'reversal' },
  },
)

export const ACCOUNT_ENFORCEMENT_IMMUTABLE_MESSAGE =
  'Account enforcement actions are append-only and cannot be updated'

const rejectMutation = () => {
  throw new Error(ACCOUNT_ENFORCEMENT_IMMUTABLE_MESSAGE)
}

accountEnforcementActionSchema.pre('updateOne', rejectMutation)
accountEnforcementActionSchema.pre('updateMany', rejectMutation)
accountEnforcementActionSchema.pre('findOneAndUpdate', rejectMutation)
accountEnforcementActionSchema.pre('replaceOne', rejectMutation)
accountEnforcementActionSchema.pre('findOneAndReplace', rejectMutation)
accountEnforcementActionSchema.pre('bulkWrite', function (operations) {
  if (
    operations.some(
      (operation) =>
        'updateOne' in operation || 'updateMany' in operation || 'replaceOne' in operation,
    )
  ) {
    rejectMutation()
  }
})
accountEnforcementActionSchema.pre('save', function () {
  if (!this.isNew && this.isModified()) rejectMutation()
})

export const AccountEnforcementAction = model<IAccountEnforcementAction>(
  'AccountEnforcementAction',
  accountEnforcementActionSchema,
)
