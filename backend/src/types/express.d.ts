import type { HydratedDocument } from 'mongoose'
import type { IUser } from '../models/userModel.js'

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends HydratedDocument<IUser> {}
  }
}

export {}
