import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isAnnouncementAuthorized } from '../policies/announcementAuthorizationPolicy.js'
import {
  createAnnouncementDraft,
  deleteAnnouncementDraft,
  getAdminAnnouncement,
  listAdminAnnouncements,
  saveAnnouncementDraft,
} from '../services/announcementDraftAdminService.js'
import {
  announcementPermissionDenied,
  parseAnnouncementAdminId,
  parseAnnouncementAdminQuery,
  parseAnnouncementCreateRequest,
  parseAnnouncementDeleteRequest,
  parseAnnouncementSaveRequest,
} from '../utils/announcementAdminPolicy.js'

type AnnouncementParams = { announcementId: string }

const handler =
  <RequestType extends Request>(operation: (req: RequestType, res: Response) => Promise<unknown>) =>
  async (req: RequestType, res: Response, next: NextFunction) => {
    try {
      await operation(req, res)
    } catch (error) {
      next(error)
    }
  }

const authorize = (req: Request, permission: 'announcement:create' | 'announcement:edit') => {
  if (!isAnnouncementAuthorized(req.user, permission)) throw announcementPermissionDenied()
}

export const listAdminAnnouncementsController = handler(async (req, res) => {
  authorize(req, 'announcement:edit')
  res
    .status(StatusCodes.OK)
    .json(await listAdminAnnouncements(parseAnnouncementAdminQuery(req.query)))
})

export const getAdminAnnouncementController = handler<Request<AnnouncementParams>>(
  async (req, res) => {
    authorize(req, 'announcement:edit')
    const announcement = await getAdminAnnouncement(
      parseAnnouncementAdminId(req.params.announcementId),
    )
    res.status(StatusCodes.OK).json({ announcement })
  },
)

export const createAnnouncementDraftController = handler(async (req, res) => {
  authorize(req, 'announcement:create')
  const announcement = await createAnnouncementDraft(parseAnnouncementCreateRequest(req.body))
  res.status(StatusCodes.CREATED).json({ announcement })
})

export const saveAnnouncementDraftController = handler<Request<AnnouncementParams>>(
  async (req, res) => {
    authorize(req, 'announcement:edit')
    const announcement = await saveAnnouncementDraft(
      parseAnnouncementAdminId(req.params.announcementId),
      parseAnnouncementSaveRequest(req.body),
    )
    res.status(StatusCodes.OK).json({ announcement })
  },
)

export const deleteAnnouncementDraftController = handler<Request<AnnouncementParams>>(
  async (req, res) => {
    authorize(req, 'announcement:edit')
    const result = await deleteAnnouncementDraft(
      parseAnnouncementAdminId(req.params.announcementId),
      parseAnnouncementDeleteRequest(req.body).expectedRevision,
    )
    res.status(StatusCodes.OK).json(result)
  },
)
