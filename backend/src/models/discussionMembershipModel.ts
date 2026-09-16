import { Schema, model } from 'mongoose'

const discussionMembershipSchema = new Schema(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'DiscussionRoom', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['joined', 'left'], required: true },
    joinedAt: { type: Date, required: true },
    leftAt: Date,
    lastReadMessageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    lastReadMessageCreatedAt: Date,
  },
  { timestamps: true },
)

discussionMembershipSchema.index({ roomId: 1, userId: 1 }, { unique: true })
discussionMembershipSchema.index({ userId: 1, status: 1, updatedAt: -1 })

export const DiscussionMembership = model('DiscussionMembership', discussionMembershipSchema)
