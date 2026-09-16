import express from 'express'
import {
  getEncounterCandidates,
  getBlockedUsers,
  getUser,
  getUsers,
  getMe,
  getMessagingPrivacy,
  getMoviePeople,
  getMovieSpace,
  updateFavoriteVisibility,
  updateProfile,
  patchMessagingPrivacy,
} from '../controllers/userController.js'
import passport from 'passport'
import { getMovieDna } from '../controllers/movieDnaController.js'
import { getDnaMatch } from '../controllers/dnaMatchController.js'
import { getFormalRecommendations } from '../controllers/formalRecommendationController.js'
import { blockUser, unblockUser } from '../controllers/blockController.js'
import { reportUser } from '../controllers/reportController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/', requireAuth, getUsers)
router.get('/recommendations', requireAuth, getFormalRecommendations)
router.get('/me', requireAuth, getMe)
router.get('/me/privacy', requireAuth, getMessagingPrivacy)
router.patch('/me/privacy', requireAuth, patchMessagingPrivacy)
router.get('/me/blocked-users', requireAuth, getBlockedUsers)
router.post('/encounter', requireAuth, getEncounterCandidates)
router.patch('/me/favorite-visibility', requireAuth, updateFavoriteVisibility)
router.patch('/me/profile', requireAuth, updateProfile)
router.put('/:userId/block', requireAuth, blockUser)
router.delete('/:userId/block', requireAuth, unblockUser)
router.post('/:userId/report', requireAuth, reportUser)
router.get('/movie/:tmdbId/people', requireAuth, getMoviePeople)
router.get('/:id/movie-space', requireAuth, getMovieSpace)
router.get('/:id/movie-dna', requireAuth, getMovieDna)
router.get('/:id/dna-match', requireAuth, getDnaMatch)
router.get('/:id', getUser)

export default router
