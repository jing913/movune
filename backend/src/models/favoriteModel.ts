import { Schema, model } from 'mongoose'

const favoriteSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    tmdbId: {
      type: Number,
      required: true,
    },
    genreIds: {
      type: [Number],
      default: [],
    },
  },
  {
    timestamps: true,
  },
)

favoriteSchema.index(
  {
    userId: 1,
    tmdbId: 1,
  },
  {
    unique: true,
  },
)

favoriteSchema.index({ tmdbId: 1, userId: 1 })

export const Favorite = model('Favorite', favoriteSchema)
