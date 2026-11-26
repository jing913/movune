import express from 'express'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import passport from 'passport'
import {
  listAdminEnforcementDecisionsController,
  reverseAdminEnforcementDecisionController,
} from '../controllers/adminEnforcementController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })
type Params = Record<string, string>
type AuthenticatedHandler<HandlerParams extends Params> = (
  actor: Express.User,
  req: Request<HandlerParams>,
  res: Response,
  next: NextFunction,
) => Promise<void>

const captureActor =
  <HandlerParams extends Params>(
    handler: AuthenticatedHandler<HandlerParams>,
  ): RequestHandler<HandlerParams> =>
  (req, res, next) => {
    if (!req.user) {
      res.sendStatus(401)
      return
    }
    void handler(req.user, req, res, next)
  }

router.get('/', requireAuth, captureActor(listAdminEnforcementDecisionsController))
router.post(
  '/:decisionId/reversal',
  requireAuth,
  captureActor(reverseAdminEnforcementDecisionController),
)

export default router
