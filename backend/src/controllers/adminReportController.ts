import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { assertReportReviewAuthorized } from '../policies/reportReviewAuthorizationPolicy.js'
import {
  listAdminReportQueue,
  parseAdminReportQueueQuery,
} from '../services/adminReportQueueReadService.js'
import { getAdminReportDetail } from '../services/adminReportDetailReadService.js'
import { getAdminReportEvidence } from '../services/adminReportEvidenceReadService.js'

type ReportParams = { reportId: string }

export const listAdminReportsController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const evaluatedAt = new Date()
  try {
    await assertReportReviewAuthorized(req.user, evaluatedAt)
    const query = parseAdminReportQueueQuery(req.query)
    res.status(StatusCodes.OK).json(await listAdminReportQueue(query))
  } catch (error) {
    next(error)
  }
}

export const getAdminReportController = async (
  req: Request<ReportParams>,
  res: Response,
  next: NextFunction,
) => {
  const evaluatedAt = new Date()
  try {
    await assertReportReviewAuthorized(req.user, evaluatedAt)
    res.status(StatusCodes.OK).json(await getAdminReportDetail(req.params.reportId, evaluatedAt))
  } catch (error) {
    next(error)
  }
}

export const getAdminReportEvidenceController = async (
  req: Request<ReportParams>,
  res: Response,
  next: NextFunction,
) => {
  const evaluatedAt = new Date()
  try {
    res
      .status(StatusCodes.OK)
      .json(await getAdminReportEvidence(req.params.reportId, req.user!, evaluatedAt))
  } catch (error) {
    next(error)
  }
}
