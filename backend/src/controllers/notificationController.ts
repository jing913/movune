import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isObjectIdOrHexString } from 'mongoose'
import { Notification } from '../models/notificationModel.js'
import type { ReportReason } from '../models/reportModel.js'
import { User } from '../models/userModel.js'
import { publishToUser } from '../services/realtimeService.js'
import {
  buildNotificationCursorFilter,
  decodeNotificationCursor,
  encodeNotificationCursor,
  NotificationInputError,
  notificationSort,
  parseNotificationLimit,
} from '../utils/notificationPolicy.js'

type NotificationParams = {
  notificationId: string
}

type PopulatedActor = {
  _id: { toString(): string }
  account: string
  displayName?: string
  avatar?: string
}

type PopulatedReport = {
  _id: { toString(): string }
  reporterUserId: { toString(): string }
  reportedUserId: { toString(): string }
  reason: ReportReason
  sourceType: 'public_profile' | 'direct_conversation' | 'direct_message'
  messageEvidence?: {
    messageId: { toString(): string }
    content: string
    sentAt: Date
  }
  createdAt: Date
}

type NotificationRecord = {
  _id: { toString(): string }
  actorId: PopulatedActor | null
  type: 'follow' | 'report_submitted'
  reportId?: PopulatedReport | null
  readAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type ReportedUserProjection = {
  _id: { toString(): string }
  account: string
  displayName?: string
}

const unavailableReportedUserLabel = '已停用的使用者'

const serializeNotification = (
  notification: NotificationRecord,
  recipientId: string,
  reportedUsers: ReadonlyMap<string, ReportedUserProjection>,
) => {
  if (notification.type === 'report_submitted') {
    const report = notification.reportId
    if (!report || report.reporterUserId.toString() !== recipientId) {
      throw new Error('Report notification ownership invariant failed')
    }
    if (report.sourceType === 'direct_message' && !report.messageEvidence) {
      throw new Error('Report notification message evidence invariant failed')
    }
    const reportedUserId = report.reportedUserId.toString()
    const reportedUser = reportedUsers.get(reportedUserId)
    return {
      id: notification._id.toString(),
      type: notification.type,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
      report: {
        reportId: report._id.toString(),
        sourceType: report.sourceType,
        reason: report.reason,
        submittedAt: report.createdAt,
        reportedUser: {
          id: reportedUserId,
          displayName:
            reportedUser?.displayName?.trim() ||
            reportedUser?.account ||
            unavailableReportedUserLabel,
        },
        ...(report.sourceType === 'direct_message'
          ? {
              message: {
                id: report.messageEvidence!.messageId.toString(),
                content: report.messageEvidence!.content,
                sentAt: report.messageEvidence!.sentAt,
              },
            }
          : {}),
      },
    }
  }

  return {
    _id: notification._id.toString(),
    type: notification.type,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    actor: notification.actorId
      ? {
          _id: notification.actorId._id.toString(),
          account: notification.actorId.account,
          displayName: notification.actorId.displayName,
          avatar: notification.actorId.avatar,
        }
      : null,
  }
}

export const getNotifications = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  let limit: number
  let cursor
  try {
    limit = parseNotificationLimit(req.query.limit)
    cursor = decodeNotificationCursor(req.query.cursor)
  } catch (error) {
    if (error instanceof NotificationInputError) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: error.message })
    }
    return next(error)
  }

  try {
    const filter = {
      recipientId: req.user._id,
      ...buildNotificationCursorFilter(cursor),
    }
    const [records, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort(notificationSort)
        .limit(limit + 1)
        .populate({ path: 'actorId', select: 'account displayName avatar' })
        .populate({
          path: 'reportId',
          match: { reporterUserId: req.user._id },
          select: 'reporterUserId reportedUserId reason sourceType messageEvidence createdAt',
        })
        .lean(),
      Notification.countDocuments({ recipientId: req.user._id, readAt: null }),
    ])
    const hasMore = records.length > limit
    const page = records.slice(0, limit) as unknown as NotificationRecord[]
    const last = page.at(-1)
    const reportedUserIds = [
      ...new Set(
        page.flatMap((notification) => {
          const report = notification.type === 'report_submitted' ? notification.reportId : null
          return report ? [report.reportedUserId.toString()] : []
        }),
      ),
    ]
    const reportedUserRecords = reportedUserIds.length
      ? ((await User.find({ _id: { $in: reportedUserIds } })
          .select('_id account displayName')
          .lean()) as unknown as ReportedUserProjection[])
      : []
    const reportedUsers = new Map(
      reportedUserRecords.map((user) => [user._id.toString(), user] as const),
    )

    return res.status(StatusCodes.OK).json({
      notifications: page.map((notification) =>
        serializeNotification(notification, req.user!._id.toString(), reportedUsers),
      ),
      unreadCount,
      nextCursor:
        hasMore && last
          ? encodeNotificationCursor({ createdAt: last.createdAt, id: last._id.toString() })
          : null,
    })
  } catch (error) {
    next(error)
  }
}

export const markNotificationRead = async (
  req: Request<NotificationParams>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const notificationId = req.params.notificationId
  if (!isObjectIdOrHexString(notificationId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid notification id' })
  }

  try {
    const now = new Date()
    const updated = await Notification.findOneAndUpdate(
      { _id: notificationId, recipientId: req.user._id, readAt: null },
      { $set: { readAt: now } },
      { new: true },
    )
      .select('_id readAt')
      .lean()
    const notification =
      updated ??
      (await Notification.findOne({ _id: notificationId, recipientId: req.user._id })
        .select('_id readAt')
        .lean())

    if (!notification) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: 'Notification not found' })
    }

    publishToUser(req.user._id.toString(), 'read.updated', {
      resource: 'notification',
      id: notification._id.toString(),
    })

    return res.status(StatusCodes.OK).json({
      notification: {
        _id: notification._id.toString(),
        readAt: notification.readAt,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const markAllNotificationsRead = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    const now = new Date()
    const result = await Notification.updateMany(
      { recipientId: req.user._id, readAt: null },
      { $set: { readAt: now } },
    )

    publishToUser(req.user._id.toString(), 'read.updated', {
      resource: 'notifications',
    })

    return res.status(StatusCodes.OK).json({ updatedCount: result.modifiedCount })
  } catch (error) {
    next(error)
  }
}
