import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isObjectIdOrHexString } from 'mongoose'
import { Favorite } from '../models/favoriteModel.js'
import { findUserById } from '../models/userModel.js'
import { calculateMovieDna, shapeMovieDnaForViewer } from '../services/movieDnaService.js'
import {
  assertMemberSocialPairAccess,
  memberSocialResourceNotFound,
} from '../services/memberSocialAccessService.js'
import { loadFavoritesForMovieDna } from '../utils/favoritesProcessingPolicy.js'

type UserParams = {
  id: string
}

export const getMovieDna = async (req: Request<UserParams>, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const userId = req.params.id
  if (!isObjectIdOrHexString(userId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid user id' })
  }

  try {
    await assertMemberSocialPairAccess(req.user._id.toString(), userId)
    const user = await findUserById(userId)
    if (!user) throw memberSocialResourceNotFound()

    const favorites = await loadFavoritesForMovieDna(() =>
      Favorite.find({ userId }).select('genreIds').lean(),
    )

    if (!favorites) {
      return res.status(StatusCodes.OK).json({
        movieDnaVisibility: 'private',
      })
    }

    const isOwner = user._id.toString() === req.user._id.toString()

    return res.status(StatusCodes.OK).json({
      movieDnaVisibility: 'available',
      movieDna: shapeMovieDnaForViewer(calculateMovieDna(favorites), isOwner),
    })
  } catch (error) {
    next(error)
  }
}
