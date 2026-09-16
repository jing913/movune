import { Schema, model } from 'mongoose'

const collectionSchema = new Schema(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    visibility: {
      type: String,
      enum: ['private', 'public'],
      default: 'private',
      required: true,
    },
    lifecycleState: {
      type: String,
      enum: ['active', 'deleted'],
      default: 'active',
      required: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
)

collectionSchema.index({ ownerId: 1, lifecycleState: 1, createdAt: -1, _id: -1 })

export const Collection = model('Collection', collectionSchema)
