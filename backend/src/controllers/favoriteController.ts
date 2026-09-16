import type { Request, Response, NextFunction } from 'express'
import { Favorite } from '../models/favoriteModel.js'
import {
  getFavoritesVisibility,
  isFavoritesVisibility,
  setFavoritesVisibility,
} from '../services/favoritesVisibilityService.js'

type FavoriteParams = {
  tmdbId: string
}

type CreateFavoriteBody = {
  tmdbId?: unknown
  genreIds?: unknown
}

type UpdateFavoritesVisibilityBody = {
  visibility?: unknown
}

export const getFavoritesVisibilityController = (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  return res.status(200).json({ visibility: getFavoritesVisibility(req.user) })
}

export const updateFavoritesVisibilityController = async (
  req: Request<Record<string, never>, unknown, UpdateFavoritesVisibilityBody>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  if (!isFavoritesVisibility(req.body.visibility)) {
    return res.status(400).json({ message: 'visibility must be private or public' })
  }

  try {
    const visibility = await setFavoritesVisibility(req.user, req.body.visibility)
    return res.status(200).json({ visibility })
  } catch (error) {
    next(error)
  }
}

export const createFavorite = async (
  req: Request<Record<string, never>, unknown, CreateFavoriteBody>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(401).json({
      message: 'Unauthorized',
    })
  }

  const userId = req.user._id
  const tmdbId = req.body.tmdbId
  const rawGenreIds = req.body.genreIds ?? []

  if (typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({
      message: 'Invalid tmdbId',
    })
  }

  if (
    !Array.isArray(rawGenreIds) ||
    rawGenreIds.length > 20 ||
    rawGenreIds.some((genreId) => !Number.isInteger(genreId) || Number(genreId) <= 0)
  ) {
    return res.status(400).json({
      message: 'Invalid genreIds',
    })
  }

  const genreIds = [...new Set(rawGenreIds as number[])]

  try {
    const favorite = await Favorite.create({
      userId,
      tmdbId,
      genreIds,
    })

    return res.status(201).json({
      favorite,
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return res.status(409).json({
        message: 'Movie already favorited',
      })
    }
    next(error)
  }
}

export const getFavorites = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({
      message: 'Unauthorized',
    })
  }

  const userId = req.user._id

  try {
    const favorites = await Favorite.find({
      userId,
    })
    return res.status(200).json({
      favorites,
    })
  } catch (error) {
    next(error)
  }
}

export const deleteFavorite = async (
  req: Request<FavoriteParams>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(401).json({
      message: 'Unauthorized',
    })
  }

  const userId = req.user._id
  const tmdbId = Number(req.params.tmdbId)

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({
      message: 'Invalid tmdbId',
    })
  }
  try {
    const favorite = await Favorite.findOneAndDelete({
      userId,
      tmdbId,
    })
    if (!favorite) {
      return res.status(404).json({
        message: 'Favorite not found',
      })
    }
    return res.status(204).send()
  } catch (error) {
    next(error)
  }
}
