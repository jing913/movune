import express from 'express'
import passport from 'passport'
import {
  addCollectionMembershipController,
  createCollectionController,
  deleteCollectionController,
  getCollectionController,
  getMyCollectionMembershipsForMovieController,
  listMyCollectionsController,
  listMyDeletedCollectionsController,
  removeCollectionMembershipController,
  reorderCollectionMembershipsController,
  restoreCollectionController,
  updateCollectionController,
} from '../controllers/collectionController.js'

const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.post('/', requireAuth, createCollectionController)
router.get('/', requireAuth, listMyCollectionsController)
router.get('/memberships', requireAuth, getMyCollectionMembershipsForMovieController)
router.get('/deleted', requireAuth, listMyDeletedCollectionsController)
router.get('/:collectionId', requireAuth, getCollectionController)
router.patch('/:collectionId', requireAuth, updateCollectionController)
router.delete('/:collectionId', requireAuth, deleteCollectionController)
router.post('/:collectionId/restore', requireAuth, restoreCollectionController)
router.post('/:collectionId/memberships', requireAuth, addCollectionMembershipController)
router.put('/:collectionId/memberships/order', requireAuth, reorderCollectionMembershipsController)
router.delete(
  '/:collectionId/memberships/:tmdbId',
  requireAuth,
  removeCollectionMembershipController,
)

export default router
