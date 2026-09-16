import express from 'express'
import { createServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import jsonwebtoken from 'jsonwebtoken'
import cors from 'cors'
import userRouter from './routes/user.js'
import { logger } from './middlewares/logger.js'
import { errorHandler } from './middlewares/errorHandler.js'
import { connect } from 'mongoose'
import authRouter from './routes/auth.js'
import cookieParser from 'cookie-parser'
import './configs/passport.js'
import { validateEmailConfiguration } from './services/emailService.js'
import favoriteRouter from './routes/favorite.js'
import followRouter from './routes/follow.js'
import notificationRouter from './routes/notification.js'
import { directRouter, discussionRouter, inboxRouter, messageRouter } from './routes/messaging.js'
import { setRealtimeServer } from './services/realtimeService.js'
import { User } from './models/userModel.js'
import { DiscussionRoom } from './models/discussionRoomModel.js'
import tmdbRouter from './routes/tmdb.js'
import { getFrontendConfiguration } from './configs/frontendConfiguration.js'
import collectionRouter from './routes/collection.js'

const app = express()
const { verify } = jsonwebtoken

const PORT = process.env.PORT ?? 3000
const { origin: frontendOrigin } = getFrontendConfiguration()

const dbUrl = process.env.DB_URL
if (!dbUrl) {
  throw new Error('DB_URL is required')
}

await connect(dbUrl)

const jwtSecret = process.env.JWT_SECRET

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required')
}

validateEmailConfiguration()

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

app.use(
  cors({
    origin: frontendOrigin,
    credentials: true,
  }),
)
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())

app.use(logger)

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' })
})

app.use('/api/users', userRouter)
app.use('/api/auth', authRouter)
app.use('/api/favorites', favoriteRouter)
app.use('/api/collections', collectionRouter)
app.use('/api/follows', followRouter)
app.use('/api/notifications', notificationRouter)
app.use('/api/inbox', inboxRouter)
app.use('/api/direct-conversations', directRouter)
app.use('/api/messages', messageRouter)
app.use('/api/discussion-rooms', discussionRouter)
app.use('/api/tmdb', tmdbRouter)

app.get('/', (_req, res) => {
  res.send('Movune API is running')
})

app.use(errorHandler)

const httpServer = createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: { origin: frontendOrigin, credentials: true },
})

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token
    if (typeof token !== 'string') return next(new Error('AUTHENTICATION_REQUIRED'))
    const payload = verify(token, jwtSecret)
    if (typeof payload !== 'object' || typeof payload.userId !== 'string') {
      return next(new Error('AUTHENTICATION_REQUIRED'))
    }
    const user = await User.findById(payload.userId).select('_id').lean()
    if (!user) return next(new Error('AUTHENTICATION_REQUIRED'))
    socket.data.userId = user._id.toString()
    next()
  } catch {
    next(new Error('AUTHENTICATION_REQUIRED'))
  }
})

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`)
  socket.on('discussion.subscribe', async (payload, acknowledge) => {
    try {
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : ''
      const exists = await DiscussionRoom.exists({ _id: roomId })
      if (!exists) throw new Error('RESOURCE_NOT_FOUND')
      await socket.join(`discussion:${roomId}`)
      acknowledge?.({ ok: true })
    } catch {
      acknowledge?.({ ok: false, error: { code: 'RESOURCE_NOT_FOUND' } })
    }
  })
  socket.on('discussion.unsubscribe', async (payload) => {
    if (typeof payload?.roomId === 'string') await socket.leave(`discussion:${payload.roomId}`)
  })
})

setRealtimeServer(io)

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`)
})
