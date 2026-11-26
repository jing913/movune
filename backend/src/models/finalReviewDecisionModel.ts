import { Schema, model, type Types } from 'mongoose'
import {
  FINAL_REVIEW_CONCLUSIONS,
  type FinalReviewConclusion,
} from '../policies/caseLifecyclePolicy.js'

export interface IFinalReviewDecision {
  caseId: Types.ObjectId
  reportId: Types.ObjectId
  conclusion: FinalReviewConclusion
  rationale: string
  reviewStartedByUserId: Types.ObjectId
  decidedByUserId: Types.ObjectId
  decidedAt: Date
  caseRevision: number
  createdAt: Date
}

const finalReviewDecisionSchema = new Schema<IFinalReviewDecision>(
  {
    caseId: { type: Schema.Types.ObjectId, ref: 'ReviewCase', required: true, immutable: true },
    reportId: { type: Schema.Types.ObjectId, ref: 'Report', required: true, immutable: true },
    conclusion: {
      type: String,
      enum: FINAL_REVIEW_CONCLUSIONS,
      required: true,
      immutable: true,
    },
    rationale: {
      type: String,
      required: true,
      immutable: true,
      validate: {
        validator: (value: string) =>
          value === value.trim() && [...value].length >= 1 && [...value].length <= 1000,
        message: 'rationale must be trimmed and contain 1-1000 Unicode code points',
      },
    },
    reviewStartedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    decidedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    decidedAt: { type: Date, required: true, immutable: true },
    caseRevision: {
      type: Number,
      required: true,
      immutable: true,
      validate: {
        validator: (value: number) => Number.isSafeInteger(value) && value === 2,
        message: 'caseRevision must be the completed-review revision',
      },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
    strictQuery: 'throw',
    autoIndex: false,
    autoCreate: false,
    collection: 'finalreviewdecisions',
  },
)

finalReviewDecisionSchema.index(
  { reportId: 1 },
  { unique: true, name: 'final_review_report_unique' },
)
finalReviewDecisionSchema.index({ caseId: 1 }, { unique: true, name: 'final_review_case_unique' })
finalReviewDecisionSchema.index({ decidedAt: 1, _id: 1 }, { name: 'final_review_retention_scan' })

export const FINAL_REVIEW_DECISION_IMMUTABLE_MESSAGE =
  'Final review decisions are immutable and cannot be mutated'

const rejectMutation = () => {
  throw new Error(FINAL_REVIEW_DECISION_IMMUTABLE_MESSAGE)
}

finalReviewDecisionSchema.pre('updateOne', rejectMutation)
finalReviewDecisionSchema.pre('updateMany', rejectMutation)
finalReviewDecisionSchema.pre('findOneAndUpdate', rejectMutation)
finalReviewDecisionSchema.pre('replaceOne', rejectMutation)
finalReviewDecisionSchema.pre('findOneAndReplace', rejectMutation)
finalReviewDecisionSchema.pre('deleteOne', { document: false, query: true }, rejectMutation)
finalReviewDecisionSchema.pre('deleteOne', { document: true, query: false }, rejectMutation)
finalReviewDecisionSchema.pre('deleteMany', rejectMutation)
finalReviewDecisionSchema.pre('findOneAndDelete', rejectMutation)
finalReviewDecisionSchema.pre('bulkWrite', function (operations) {
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
finalReviewDecisionSchema.pre('save', function () {
  if (!this.isNew && this.isModified()) rejectMutation()
})

export const FinalReviewDecision = model<IFinalReviewDecision>(
  'FinalReviewDecision',
  finalReviewDecisionSchema,
)
