import express from 'express'
import passport from 'passport'
import {
  getAdminMemberController,
  listAdminMembersController,
} from '../controllers/adminMemberController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/', requireAuth, listAdminMembersController)
router.get('/:memberId', requireAuth, getAdminMemberController)

export default router
