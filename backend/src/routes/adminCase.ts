import express from 'express'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import passport from 'passport'
import {
  beginAdminCaseReviewController,
  createAdminCaseEnforcementController,
  finalizeAdminCaseReviewController,
  getAdminCaseController,
  listAdminCaseEnforcementGuidelinesController,
  listAdminCasesController,
} from '../controllers/adminCaseController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })
type CaseParams = { reportId: string }
type AuthenticatedCaseMutationHandler = (
  actor: Express.User,
  req: Request<CaseParams>,
  res: Response,
  next: NextFunction,
) => Promise<void>

const captureAuthenticatedActor =
  (handler: AuthenticatedCaseMutationHandler): RequestHandler<CaseParams> =>
  (req, res, next) => {
    const actor = req.user
    if (!actor) {
      res.sendStatus(401)
      return
    }
    void handler(actor, req, res, next)
  }

router.get('/', requireAuth, listAdminCasesController)
router.get(
  '/enforcement-guidelines',
  requireAuth,
  captureAuthenticatedActor(listAdminCaseEnforcementGuidelinesController),
)
router.get('/:reportId', requireAuth, getAdminCaseController)
router.post(
  '/:reportId/begin-review',
  requireAuth,
  captureAuthenticatedActor(beginAdminCaseReviewController),
)
router.post(
  '/:reportId/finalize-review',
  requireAuth,
  captureAuthenticatedActor(finalizeAdminCaseReviewController),
)
router.post(
  '/:reportId/enforcement-decisions',
  requireAuth,
  captureAuthenticatedActor(createAdminCaseEnforcementController),
)

export default router
