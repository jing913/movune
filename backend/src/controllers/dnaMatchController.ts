import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isObjectIdOrHexString } from 'mongoose'
import { Favorite } from '../models/favoriteModel.js'
import { findUserById } from '../models/userModel.js'
import { processDnaMatch, shapeDnaMatchForViewer } from '../services/dnaMatchService.js'
import { getFavoritesVisibility } from '../services/favoritesVisibilityService.js'
import { loadFavoritesForMatch } from '../utils/favoritesProcessingPolicy.js'

type UserParams = {
  id: string
}

export const getDnaMatch = async (req: Request<UserParams>, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const otherUserId = req.params.id
  if (!isObjectIdOrHexString(otherUserId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid user id' })
  }

  try {
    const viewerUserId = req.user._id
    const otherUser = await findUserById(otherUserId)
    if (!otherUser) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: 'User not found' })
    }

    const [viewerFavorites, otherUserFavorites] = await Promise.all([
      loadFavoritesForMatch(() =>
        Favorite.find({ userId: viewerUserId }).select('tmdbId genreIds').lean(),
      ),
      loadFavoritesForMatch(() =>
        Favorite.find({ userId: otherUserId }).select('tmdbId genreIds').lean(),
      ),
    ])

    const processedMatch = processDnaMatch(viewerFavorites ?? [], otherUserFavorites ?? [], {
      viewerId: viewerUserId,
      otherUserId: otherUser._id,
      otherUserFavoritesVisibility: getFavoritesVisibility(otherUser),
    })

    return res.status(StatusCodes.OK).json({
      dnaMatch: shapeDnaMatchForViewer(processedMatch),
    })
  } catch (error) {
    next(error)
  }
}
