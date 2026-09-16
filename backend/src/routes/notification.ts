import express from 'express'
import passport from 'passport'
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../controllers/notificationController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/', requireAuth, getNotifications)
router.patch('/read-all', requireAuth, markAllNotificationsRead)
router.patch('/:notificationId/read', requireAuth, markNotificationRead)

export default router
