import { Schema, model, type Types } from 'mongoose'

export type DirectState = 'pending' | 'unlocked' | 'declined' | 'revoked'

const lastMessageSchema = new Schema(
  {
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    preview: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
)

const directConversationSchema = new Schema(
  {
    participantIds: {
      type: [Schema.Types.ObjectId],
      required: true,
      validate: {
        validator: (ids: Types.ObjectId[]) =>
          ids.length === 2 && ids[0]?.toString() !== ids[1]?.toString(),
        message: 'A direct conversation requires exactly two distinct participants',
      },
    },
    participantKey: { type: String, required: true, unique: true },
    initiatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    state: {
      type: String,
      enum: ['pending', 'unlocked', 'declined', 'revoked'],
      required: true,
    },
    unlockedAt: Date,
    unlockReason: { type: String, enum: ['reply', 'follow', 'accept'] },
    declinedAt: Date,
    revokedAt: Date,
    revocationReason: { type: String, enum: ['block'] },
    lastMessage: { type: lastMessageSchema, default: null },
  },
  { timestamps: true },
)

directConversationSchema.index({ participantIds: 1 })
directConversationSchema.index({ 'lastMessage.createdAt': -1, _id: -1 })

export const DirectConversation = model('DirectConversation', directConversationSchema)
