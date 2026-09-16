import express from 'express'
import passport from 'passport'
import {
  acceptDirectController,
  declineDirectController,
  directMessagesController,
  directReadController,
  discussionMessagesController,
  discussionReadController,
  getDirectController,
  getDiscussionController,
  inboxSummaryController,
  joinDiscussionController,
  leaveDiscussionController,
  listDirectController,
  listDiscussionController,
  resolveDirectController,
  resolveDiscussionController,
  sendDirectController,
  sendDiscussionController,
  sendFirstDirectController,
} from '../controllers/messagingController.js'
import {
  reportDirectConversationUser,
  reportDirectMessage,
} from '../controllers/reportController.js'

export const requireAuth = passport.authenticate('jwt', { session: false })

export const inboxRouter = express.Router().get('/summary', requireAuth, inboxSummaryController)

export const directRouter = express.Router()
directRouter.use(requireAuth)
directRouter.post('/resolve', resolveDirectController)
directRouter.post('/messages', sendFirstDirectController)
directRouter.get('/', listDirectController)
directRouter.get('/:conversationId', getDirectController)
directRouter.get('/:conversationId/messages', directMessagesController)
directRouter.post('/:conversationId/messages', sendDirectController)
directRouter.post('/:conversationId/accept', acceptDirectController)
directRouter.post('/:conversationId/decline', declineDirectController)
directRouter.post('/:conversationId/read', directReadController)
directRouter.post('/:conversationId/report-user', reportDirectConversationUser)

export const messageRouter = express.Router()
messageRouter.use(requireAuth)
messageRouter.post('/:messageId/report', reportDirectMessage)

export const discussionRouter = express.Router()
discussionRouter.use(requireAuth)
discussionRouter.post('/resolve', resolveDiscussionController)
discussionRouter.get('/', listDiscussionController)
discussionRouter.get('/:roomId', getDiscussionController)
discussionRouter.get('/:roomId/messages', discussionMessagesController)
discussionRouter.put('/:roomId/membership', joinDiscussionController)
discussionRouter.delete('/:roomId/membership', leaveDiscussionController)
discussionRouter.post('/:roomId/messages', sendDiscussionController)
discussionRouter.post('/:roomId/read', discussionReadController)
