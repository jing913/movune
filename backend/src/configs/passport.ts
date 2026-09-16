import passport from 'passport'
import { Strategy, ExtractJwt } from 'passport-jwt'
import { User } from '../models/userModel.js'

const jwtSecret = process.env.JWT_SECRET

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required')
}

const options = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: jwtSecret,
}

const strategy = new Strategy(options, async (payload, done) => {
  const user = await User.findById(payload.userId)

  if (!user) {
    done(null, false)
    return
  }

  done(null, user)
})

passport.use(strategy)
