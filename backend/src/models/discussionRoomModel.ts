import { Schema, model } from 'mongoose'

const discussionRoomSchema = new Schema(
  {
    tmdbId: { type: Number, required: true, unique: true, min: 1 },
    movieSnapshot: {
      title: { type: String, required: true },
      posterPath: { type: String, default: null },
    },
    lastMessage: {
      type: new Schema(
        {
          messageId: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
          senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          preview: { type: String, required: true },
          createdAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
)

discussionRoomSchema.index({ 'lastMessage.createdAt': -1, _id: -1 })

export const DiscussionRoom = model('DiscussionRoom', discussionRoomSchema)
