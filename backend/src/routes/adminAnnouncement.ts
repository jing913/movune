import express from 'express'
import passport from 'passport'
import {
  createAnnouncementDraftController,
  deleteAnnouncementDraftController,
  editPublishedAnnouncementController,
  getAdminAnnouncementController,
  historicalPublishAnnouncementController,
  listAdminAnnouncementsController,
  publishAnnouncementController,
  removeAnnouncementController,
  restoreAnnouncementController,
  saveAnnouncementDraftController,
  transitionAnnouncementMaintenanceController,
  withdrawAnnouncementController,
} from '../controllers/adminAnnouncementController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/', requireAuth, listAdminAnnouncementsController)
router.get('/:announcementId', requireAuth, getAdminAnnouncementController)
router.post('/', requireAuth, createAnnouncementDraftController)
router.patch('/:announcementId', requireAuth, saveAnnouncementDraftController)
router.delete('/:announcementId', requireAuth, deleteAnnouncementDraftController)
router.post('/:announcementId/publish', requireAuth, publishAnnouncementController)
router.post(
  '/:announcementId/historical-publish',
  requireAuth,
  historicalPublishAnnouncementController,
)
router.patch('/:announcementId/published-content', requireAuth, editPublishedAnnouncementController)
router.post('/:announcementId/withdraw', requireAuth, withdrawAnnouncementController)
router.post('/:announcementId/restore', requireAuth, restoreAnnouncementController)
router.post('/:announcementId/remove', requireAuth, removeAnnouncementController)
router.post(
  '/:announcementId/maintenance-transition',
  requireAuth,
  transitionAnnouncementMaintenanceController,
)

export default router
