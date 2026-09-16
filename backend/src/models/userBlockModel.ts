import { Schema, model } from 'mongoose'

const userBlockSchema = new Schema(
  {
    blockerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    blockedUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  },
)

userBlockSchema.index({ blockerUserId: 1, blockedUserId: 1 }, { unique: true })
userBlockSchema.index({ blockerUserId: 1, createdAt: -1, _id: -1 })

export const UserBlock = model('UserBlock', userBlockSchema)
