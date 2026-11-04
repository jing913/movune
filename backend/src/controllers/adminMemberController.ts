import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { assertMemberReadAuthorized } from '../policies/memberReadAuthorizationPolicy.js'
import {
  getAdminMember,
  listAdminMembers,
  parseAdminMemberListQuery,
} from '../services/adminMemberReadService.js'

type MemberParams = { memberId: string }

const handler =
  <RequestType extends Request>(
    operation: (req: RequestType, res: Response, evaluatedAt: Date) => Promise<unknown>,
  ) =>
  async (req: RequestType, res: Response, next: NextFunction) => {
    const evaluatedAt = new Date()
    try {
      await assertMemberReadAuthorized(req.user, evaluatedAt)
      await operation(req, res, evaluatedAt)
    } catch (error) {
      next(error)
    }
  }

export const listAdminMembersController = handler(async (req, res, evaluatedAt) => {
  const query = parseAdminMemberListQuery(req.query)
  res.status(StatusCodes.OK).json(await listAdminMembers(query, evaluatedAt))
})

export const getAdminMemberController = handler<Request<MemberParams>>(
  async (req, res, evaluatedAt) => {
    const member = await getAdminMember(req.params.memberId, evaluatedAt)
    res.status(StatusCodes.OK).json({ member })
  },
)
