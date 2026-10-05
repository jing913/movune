import express from 'express'
import {
  getPublicAnnouncementController,
  listPublicAnnouncementsController,
} from '../controllers/announcementController.js'

const router = express.Router()

router.get('/', listPublicAnnouncementsController)
router.get('/:announcementId', getPublicAnnouncementController)

export default router
