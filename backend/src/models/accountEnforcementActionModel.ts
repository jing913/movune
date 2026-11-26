import { Schema, model, type Types } from 'mongoose'
import {
  ACCOUNT_ENFORCEMENT_DECISION_TYPES,
  ENFORCEMENT_IDENTIFIER_MAX_LENGTH,
  ENFORCEMENT_IDENTIFIER_PATTERN,
  ENFORCEMENT_GUIDELINE_RULE_PATTERN,
  ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH,
  type AccountEnforcementDecisionType,
  type AccountEnforcementRecordType,
} from '../utils/accountEnforcementPolicy.js'

export interface IAccountEnforcementAction {
  targetUserId: Types.ObjectId
  recordType: AccountEnforcementRecordType
  effectiveAt: Date
  performedByUserId: Types.ObjectId
  reviewDecisionId?: Types.ObjectId
  operationId?: string
  commandDigest?: string
  memberNoticeProvenance?: typeof STAGE_B_MEMBER_NOTICE_PROVENANCE
  reasonCode?: string
  reasonSummary: string
  memberFacingReasonSummary?: string
  decisionType?: AccountEnforcementDecisionType
  guidelineRuleId?: string
  guidelineVersion?: string
  endsAt?: Date
  reversesDecisionId?: Types.ObjectId
  createdAt: Date
}

export const STAGE_B_MEMBER_NOTICE_PROVENANCE = 'stage_b_formal_warning_v1' as const

type ValidationContext = Partial<IAccountEnforcementAction>

const requiredForDecision = function (this: ValidationContext) {
  return this.recordType === 'decision'
}

const requiredForCodedRecord = function (this: ValidationContext) {
  return (
    this.recordType === 'reversal' ||
    (this.recordType === 'decision' && this.decisionType !== 'no_action')
  )
}

const requiredForViolationDecision = function (this: ValidationContext) {
  return this.recordType === 'decision' && this.decisionType !== 'no_action'
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

const trustedMemberNoticeOnly = function (this: ValidationContext, value: unknown) {
  if (value == null) return true
  return (
    value === STAGE_B_MEMBER_NOTICE_PROVENANCE &&
    this.recordType === 'decision' &&
    this.decisionType === 'formal_warning' &&
    this.reviewDecisionId != null &&
    this.operationId != null &&
    this.commandDigest != null
  )
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
  immutable: true,
  trim: true,
  maxlength: ENFORCEMENT_IDENTIFIER_MAX_LENGTH,
  match: ENFORCEMENT_IDENTIFIER_PATTERN,
} as const

const guidelineRuleField = {
  ...identifierField,
  match: ENFORCEMENT_GUIDELINE_RULE_PATTERN,
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
    reviewDecisionId: {
      type: Schema.Types.ObjectId,
      ref: 'FinalReviewDecision',
      immutable: true,
      validate: {
        validator: decisionOnly,
        message: 'reviewDecisionId is only supported for decisions',
      },
    },
    operationId: {
      ...identifierField,
      required: false,
    },
    commandDigest: {
      type: String,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    memberNoticeProvenance: {
      type: String,
      enum: [STAGE_B_MEMBER_NOTICE_PROVENANCE],
      immutable: true,
      validate: {
        validator: trustedMemberNoticeOnly,
        message: 'memberNoticeProvenance requires a trusted Stage B Formal Warning command',
      },
    },
    reasonCode: {
      ...identifierField,
      required: requiredForCodedRecord,
    },
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
    memberFacingReasonSummary: {
      type: String,
      cast: false,
      immutable: true,
      validate: [
        {
          validator: reversalOnly,
          message: 'memberFacingReasonSummary is only supported for reversals',
        },
        {
          validator: (value: unknown) =>
            value === undefined ||
            (typeof value === 'string' &&
              value === value.trim() &&
              value.length > 0 &&
              [...value].length <= ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH),
          message: `memberFacingReasonSummary cannot exceed ${ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH} characters and must be non-empty and trimmed`,
        },
      ],
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
      ...guidelineRuleField,
      required: requiredForViolationDecision,
      validate: {
        validator: decisionOnly,
        message: 'guidelineRuleId is only supported for decisions',
      },
    },
    guidelineVersion: {
      ...identifierField,
      required: requiredForViolationDecision,
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
  { reviewDecisionId: 1 },
  {
    unique: true,
    partialFilterExpression: { recordType: 'decision', reviewDecisionId: { $exists: true } },
  },
)
accountEnforcementActionSchema.index(
  { operationId: 1 },
  {
    unique: true,
    partialFilterExpression: { operationId: { $exists: true } },
  },
)
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

accountEnforcementActionSchema.pre('validate', function () {
  if (this.recordType === 'reversal') {
    const hasOperationId = this.operationId !== null && this.operationId !== undefined
    const hasCommandDigest = this.commandDigest !== null && this.commandDigest !== undefined
    if (hasOperationId !== hasCommandDigest) {
      this.invalidate(
        hasOperationId ? 'commandDigest' : 'operationId',
        'Reversal operationId and commandDigest must be supplied together',
      )
    }
  }

  if (this.recordType !== 'decision' || this.decisionType !== 'no_action') return
  const hasGuidelineRule = this.guidelineRuleId !== null && this.guidelineRuleId !== undefined
  const hasGuidelineVersion = this.guidelineVersion !== null && this.guidelineVersion !== undefined
  if (hasGuidelineRule !== hasGuidelineVersion) {
    this.invalidate(
      hasGuidelineRule ? 'guidelineVersion' : 'guidelineRuleId',
      'No Action guideline rule and version must be supplied together',
    )
  }
})

export const AccountEnforcementAction = model<IAccountEnforcementAction>(
  'AccountEnforcementAction',
  accountEnforcementActionSchema,
)
