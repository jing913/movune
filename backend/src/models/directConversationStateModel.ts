import { Schema, model } from 'mongoose'

const directConversationStateSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'DirectConversation', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastReadMessageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    lastReadMessageCreatedAt: Date,
  },
  { timestamps: true },
)

directConversationStateSchema.index({ conversationId: 1, userId: 1 }, { unique: true })
directConversationStateSchema.index({ userId: 1, updatedAt: -1 })

export const DirectConversationState = model(
  'DirectConversationState',
  directConversationStateSchema,
)
