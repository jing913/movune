import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { listFormalRecommendations } from '../services/formalRecommendationService.js'

type FormalRecommendationsQuery = {
  page?: string
  limit?: string
}

export const getFormalRecommendations = async (
  req: Request<Record<string, never>, unknown, unknown, FormalRecommendationsQuery>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const page = Number(req.query.page ?? 1)
  const limit = Number(req.query.limit ?? 12)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 30) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid recommendations query' })
  }

  try {
    const result = await listFormalRecommendations(req.user._id, page, limit)
    return res.status(StatusCodes.OK).json(result)
  } catch (error) {
    next(error)
  }
}
