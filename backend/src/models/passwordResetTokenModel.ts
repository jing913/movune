import { Schema, model, Types } from 'mongoose'

interface IPasswordResetToken {
  user: Types.ObjectId
  tokenHash: string
  expiresAt: Date
}

const passwordResetTokenSchema = new Schema<IPasswordResetToken>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: {
        expires: 0,
      },
    },
  },
  {
    timestamps: true,
  },
)

export const PasswordResetToken = model('PasswordResetToken', passwordResetTokenSchema)
