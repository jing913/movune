import express from 'express'
import passport from 'passport'
import {
  getAdminReportController,
  getAdminReportEvidenceController,
  listAdminReportsController,
} from '../controllers/adminReportController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/', requireAuth, listAdminReportsController)
router.get('/:reportId/evidence', requireAuth, getAdminReportEvidenceController)
router.get('/:reportId', requireAuth, getAdminReportController)

export default router
