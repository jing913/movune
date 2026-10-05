import express from 'express'
import passport from 'passport'
import {
  createAnnouncementDraftController,
  deleteAnnouncementDraftController,
  getAdminAnnouncementController,
  listAdminAnnouncementsController,
  saveAnnouncementDraftController,
} from '../controllers/adminAnnouncementController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/', requireAuth, listAdminAnnouncementsController)
router.get('/:announcementId', requireAuth, getAdminAnnouncementController)
router.post('/', requireAuth, createAnnouncementDraftController)
router.patch('/:announcementId', requireAuth, saveAnnouncementDraftController)
router.delete('/:announcementId', requireAuth, deleteAnnouncementDraftController)

export default router
