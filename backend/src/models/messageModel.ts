import { Schema, model } from 'mongoose'

const messageSchema = new Schema(
  {
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    clientMessageId: { type: String, required: true, trim: true },
    contextType: { type: String, enum: ['direct', 'discussion'], required: true },
    contextId: { type: Schema.Types.ObjectId, required: true },
    content: { type: String, required: true },
  },
  { timestamps: true },
)

messageSchema.index({ senderId: 1, clientMessageId: 1 }, { unique: true })
messageSchema.index({ contextType: 1, contextId: 1, createdAt: 1, _id: 1 })

export const Message = model('Message', messageSchema)
