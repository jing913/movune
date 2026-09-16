import { Schema, model } from 'mongoose'

const collectionMembershipSchema = new Schema(
  {
    collectionId: {
      type: Schema.Types.ObjectId,
      ref: 'Collection',
      required: true,
    },
    tmdbId: {
      type: Number,
      required: true,
      min: 1,
    },
    position: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isInteger,
    },
  },
  {
    timestamps: true,
  },
)

collectionMembershipSchema.index({ collectionId: 1, tmdbId: 1 }, { unique: true })
collectionMembershipSchema.index({ collectionId: 1, position: 1, _id: 1 })

export const CollectionMembership = model('CollectionMembership', collectionMembershipSchema)
