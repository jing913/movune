import express from 'express'
import {
  discoverMoviesController,
  movieDetailsController,
  movieGenresController,
  movieRecommendationsController,
  nowPlayingMoviesController,
  popularMoviesController,
  searchMoviesController,
} from '../controllers/tmdbController.js'

const router = express.Router()

router.get('/movie/popular', popularMoviesController)
router.get('/movie/now_playing', nowPlayingMoviesController)
router.get('/search/movie', searchMoviesController)
router.get('/discover/movie', discoverMoviesController)
router.get('/genre/movie/list', movieGenresController)
router.get('/movie/:movieId/recommendations', movieRecommendationsController)
router.get('/movie/:movieId', movieDetailsController)

export default router
