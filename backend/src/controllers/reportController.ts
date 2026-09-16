import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import {
  submitDirectConversationReport,
  submitDirectMessageReport,
  submitProfileReport,
  type ReportServiceDependencies,
} from '../services/reportService.js'

type ReportSubmitter = (
  reporterUserId: string,
  resourceId: unknown,
  body: unknown,
  dependencies?: ReportServiceDependencies,
) => Promise<{
  _id: { toString(): string }
  sourceType: 'public_profile' | 'direct_conversation' | 'direct_message'
  createdAt: Date
}>

const createReportController =
  (submit: ReportSubmitter, parameterName: string) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
    try {
      const report = await submit(req.user._id.toString(), req.params[parameterName], req.body)
      return res.status(StatusCodes.CREATED).json({
        report: {
          id: report._id.toString(),
          sourceType: report.sourceType,
          submittedAt: report.createdAt,
        },
      })
    } catch (error) {
      next(error)
    }
  }

export const reportUser = createReportController(submitProfileReport, 'userId')
export const reportDirectConversationUser = createReportController(
  submitDirectConversationReport,
  'conversationId',
)
export const reportDirectMessage = createReportController(submitDirectMessageReport, 'messageId')
