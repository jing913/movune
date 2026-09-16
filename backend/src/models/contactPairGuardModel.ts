import { Schema, model } from 'mongoose'

const contactPairGuardSchema = new Schema(
  {
    participantKey: {
      type: String,
      required: true,
      unique: true,
    },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
  },
  {
    timestamps: true,
  },
)

export const ContactPairGuard = model('ContactPairGuard', contactPairGuardSchema)
