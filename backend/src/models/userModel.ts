import { Schema, model } from 'mongoose'
import { hash } from 'bcrypt'

export interface IUser {
  account: string
  displayName?: string
  email: string
  password: string
  avatar?: string
  bio?: string
  favoritesPublic?: boolean
  messageRequestPreference?: 'all_members' | 'followed_members'
  role: 'user' | 'admin'
}

const userSchema = new Schema<IUser>(
  {
    account: {
      type: String,
      required: true,
      unique: true,
    },
    displayName: {
      type: String,
      trim: true,
      maxlength: 40,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    avatar: {
      type: String,
    },
    bio: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    favoritesPublic: {
      type: Boolean,
      default: false,
    },
    messageRequestPreference: {
      type: String,
      enum: ['all_members', 'followed_members'],
      default: 'all_members',
    },
    role: {
      type: String,
      default: 'user',
      enum: ['user', 'admin'],
    },
  },
  {
    timestamps: true,
  },
)

userSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return
  }
  const result = await hash(this.password, 10)
  this.password = result
})

export const User = model('User', userSchema)

export const findUserById = (id: string) => {
  return User.findById(id)
}
