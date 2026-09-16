import express from 'express'
import passport from 'passport'
import {
  createFavorite,
  deleteFavorite,
  getFavorites,
  getFavoritesVisibilityController,
  updateFavoritesVisibilityController,
} from '../controllers/favoriteController.js'
const router = express.Router()
const requireAuth = passport.authenticate('jwt', { session: false })

router.get('/visibility', requireAuth, getFavoritesVisibilityController)
router.patch('/visibility', requireAuth, updateFavoritesVisibilityController)
router.post('/', requireAuth, createFavorite)
router.get('/', requireAuth, getFavorites)
router.delete('/:tmdbId', requireAuth, deleteFavorite)

export default router
