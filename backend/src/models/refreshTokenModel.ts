import { Schema, model, Types } from 'mongoose'

interface IRefreshToken {
  user: Types.ObjectId
  refreshToken: string
  expiresAt: Date
  rememberMe: boolean
}

const refreshTokenSchema = new Schema<IRefreshToken>({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  refreshToken: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  rememberMe: {
    type: Boolean,
    required: true,
    default: true,
  },
})

export const RefreshToken = model('RefreshToken', refreshTokenSchema)
