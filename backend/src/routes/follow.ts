import express from 'express'
import passport from 'passport'
import {
  followUser,
  getFollowSummary,
  getMyFollowing,
  getMyFollowingUsers,
  getMyFollowerUsers,
  unfollowUser,
} from '../controllers/followController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/', requireAuth, getMyFollowing)
router.get('/me/following', requireAuth, getMyFollowingUsers)
router.get('/me/followers', requireAuth, getMyFollowerUsers)
router.get('/:userId', requireAuth, getFollowSummary)
router.post('/:userId', requireAuth, followUser)
router.delete('/:userId', requireAuth, unfollowUser)

export default router
