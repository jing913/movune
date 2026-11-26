import { Schema, isObjectIdOrHexString, model, type Types } from 'mongoose'

export const PERSISTED_REVIEW_CASE_STATES = ['under_review', 'review_completed'] as const
export type PersistedReviewCaseState = (typeof PERSISTED_REVIEW_CASE_STATES)[number]

export interface IReviewCase {
  reportId: Types.ObjectId
  state: PersistedReviewCaseState
  reviewStartedByUserId: Types.ObjectId
  reviewStartedAt: Date
  decisionId?: Types.ObjectId
  completedAt?: Date
  revision: number
  createdAt: Date
  updatedAt: Date
}

const reviewCaseSchema = new Schema<IReviewCase>(
  {
    reportId: { type: Schema.Types.ObjectId, ref: 'Report', required: true, immutable: true },
    state: { type: String, enum: PERSISTED_REVIEW_CASE_STATES, required: true },
    reviewStartedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    reviewStartedAt: { type: Date, required: true, immutable: true },
    decisionId: {
      type: Schema.Types.ObjectId,
      ref: 'FinalReviewDecision',
    },
    completedAt: {
      type: Date,
    },
    revision: {
      type: Number,
      required: true,
      validate: {
        validator: function (this: IReviewCase, value: number) {
          return (
            Number.isSafeInteger(value) &&
            ((this.state === 'under_review' && value === 1) ||
              (this.state === 'review_completed' && value === 2))
          )
        },
        message: 'revision must match the persisted Case lifecycle state',
      },
    } as never,
  },
  {
    strict: 'throw',
    strictQuery: 'throw',
    autoIndex: false,
    autoCreate: false,
    collection: 'reviewcases',
  },
)

reviewCaseSchema.index({ reportId: 1 }, { unique: true, name: 'review_case_report_unique' })

reviewCaseSchema.pre('validate', function () {
  const completed = this.state === 'review_completed'
  const hasValidDecisionId =
    this.decisionId !== null &&
    this.decisionId !== undefined &&
    isObjectIdOrHexString(this.decisionId)
  const hasValidCompletedAt =
    this.completedAt instanceof Date && Number.isFinite(this.completedAt.valueOf())
  if (completed !== hasValidDecisionId) {
    this.invalidate('decisionId', 'decisionId is required only for a completed review')
  }
  if (completed !== hasValidCompletedAt) {
    this.invalidate('completedAt', 'completedAt is required only for a completed review')
  }
})

export const REVIEW_CASE_MUTATION_REJECTED_MESSAGE =
  'Review Cases may only use the conditional under-review finalization update'

const rejectMutation = () => {
  throw new Error(REVIEW_CASE_MUTATION_REJECTED_MESSAGE)
}

reviewCaseSchema.pre('updateOne', rejectMutation)
reviewCaseSchema.pre('updateMany', rejectMutation)
reviewCaseSchema.pre('replaceOne', rejectMutation)
reviewCaseSchema.pre('findOneAndReplace', rejectMutation)
reviewCaseSchema.pre('deleteOne', { document: false, query: true }, rejectMutation)
reviewCaseSchema.pre('deleteOne', { document: true, query: false }, rejectMutation)
reviewCaseSchema.pre('deleteMany', rejectMutation)
reviewCaseSchema.pre('findOneAndDelete', rejectMutation)
reviewCaseSchema.pre('bulkWrite', function (operations) {
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
reviewCaseSchema.pre('findOneAndUpdate', function () {
  const filter = this.getFilter()
  const update = this.getUpdate() as Record<string, unknown> | null
  const options = this.getOptions()
  const mongooseOptions = this.mongooseOptions()
  const set = update?.$set as Record<string, unknown> | undefined
  const increment = update?.$inc as Record<string, unknown> | undefined
  const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
    const actual = Object.keys(value)
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  }
  const permitted =
    isObjectIdOrHexString(filter._id) &&
    filter.state === 'under_review' &&
    filter.revision === 1 &&
    filter.decisionId !== null &&
    typeof filter.decisionId === 'object' &&
    (filter.decisionId as Record<string, unknown>).$exists === false &&
    update !== null &&
    exactKeys(update, ['$set', '$inc']) &&
    set !== undefined &&
    exactKeys(set, ['state', 'decisionId', 'completedAt']) &&
    set.state === 'review_completed' &&
    isObjectIdOrHexString(set.decisionId) &&
    set.completedAt instanceof Date &&
    Number.isFinite(set.completedAt.valueOf()) &&
    increment !== undefined &&
    exactKeys(increment, ['revision']) &&
    increment.revision === 1 &&
    options.upsert !== true &&
    mongooseOptions.timestamps !== false
  if (!permitted) rejectMutation()
})

// Register managed timestamps after the guard so it validates caller intent first;
// Mongoose then adds the legitimate server-controlled updatedAt field.
reviewCaseSchema.set('timestamps', true)
reviewCaseSchema.pre('save', function () {
  if (!this.isNew && this.isModified()) rejectMutation()
})

export const ReviewCase = model<IReviewCase>('ReviewCase', reviewCaseSchema)
