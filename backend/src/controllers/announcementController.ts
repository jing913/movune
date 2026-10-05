import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import {
  getPublicAnnouncement,
  listPublicAnnouncements,
} from '../services/announcementPublicService.js'
import {
  decodeAnnouncementPublicCursor,
  parseAnnouncementCategory,
  parseAnnouncementPublicId,
  parseAnnouncementPublicLimit,
} from '../utils/announcementPublicPolicy.js'

type AnnouncementParams = {
  announcementId: string
}

const publicCacheHeaders = (res: Response) => res.set('Cache-Control', 'no-cache')

export const listPublicAnnouncementsController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const category = parseAnnouncementCategory(req.query.category)
    const result = await listPublicAnnouncements({
      ...(category ? { category } : {}),
      cursor: decodeAnnouncementPublicCursor(req.query.cursor),
      limit: parseAnnouncementPublicLimit(req.query.limit),
    })
    publicCacheHeaders(res).status(StatusCodes.OK).json(result)
  } catch (error) {
    next(error)
  }
}

export const getPublicAnnouncementController = async (
  req: Request<AnnouncementParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const announcement = await getPublicAnnouncement(
      parseAnnouncementPublicId(req.params.announcementId),
    )
    publicCacheHeaders(res).status(StatusCodes.OK).json({ announcement })
  } catch (error) {
    next(error)
  }
}
