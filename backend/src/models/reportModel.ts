import { Schema, model } from 'mongoose'

export type ReportReason = 'harassment_or_uncomfortable' | 'spam_or_suspicious' | 'other'
export type ReportSourceType = 'public_profile' | 'direct_conversation' | 'direct_message'

type ReportValidationContext = {
  sourceType?: ReportSourceType
}

const messageEvidenceSchema = new Schema(
  {
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    senderUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    sentAt: { type: Date, required: true },
  },
  { _id: false },
)

const reportSchema = new Schema(
  {
    reporterUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reportedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: {
      type: String,
      enum: ['harassment_or_uncomfortable', 'spam_or_suspicious', 'other'],
      required: true,
    },
    description: String,
    sourceType: {
      type: String,
      enum: ['public_profile', 'direct_conversation', 'direct_message'],
      required: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'DirectConversation',
      required: function (this: ReportValidationContext) {
        return this.sourceType === 'direct_conversation' || this.sourceType === 'direct_message'
      },
      validate: {
        validator: function (this: ReportValidationContext, value: unknown) {
          return this.sourceType !== 'public_profile' || value == null
        },
        message: 'conversationId is not supported for public_profile reports',
      },
    },
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
      required: function (this: ReportValidationContext) {
        return this.sourceType === 'direct_message'
      },
      validate: {
        validator: function (this: ReportValidationContext, value: unknown) {
          return this.sourceType === 'direct_message' || value == null
        },
        message: 'messageId is only supported for direct_message reports',
      },
    },
    messageEvidence: {
      type: messageEvidenceSchema,
      required: function (this: ReportValidationContext) {
        return this.sourceType === 'direct_message'
      },
      validate: {
        validator: function (this: ReportValidationContext, value: unknown) {
          return this.sourceType === 'direct_message' || value == null
        },
        message: 'messageEvidence is only supported for direct_message reports',
      },
    },
  },
  {
    timestamps: true,
  },
)

export const Report = model('Report', reportSchema)
