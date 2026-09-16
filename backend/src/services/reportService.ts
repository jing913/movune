import { Types, isObjectIdOrHexString } from 'mongoose'
import { DirectConversation } from '../models/directConversationModel.js'
import { Message } from '../models/messageModel.js'
import { Notification } from '../models/notificationModel.js'
import { Report, type ReportSourceType } from '../models/reportModel.js'
import { User } from '../models/userModel.js'
import { ApiProblem, invalidInput } from '../utils/messagingPolicy.js'
import { parseReportRequest, type ReportRequest } from '../utils/reportPolicy.js'
import { publishToUser } from './realtimeService.js'

type ReportRecord = Readonly<{
  _id: Types.ObjectId
  sourceType: ReportSourceType
  createdAt: Date
}>

type ReportPersistence = Record<string, unknown> & {
  reporterUserId: Types.ObjectId
  reportedUserId: Types.ObjectId
  reason: ReportRequest['reason']
  sourceType: ReportSourceType
}

type ReportNotification = Readonly<{
  recipientId: Types.ObjectId
  type: 'report_submitted'
  reportId: Types.ObjectId
  messageId?: Types.ObjectId
}>

export type ReportServiceDependencies = Readonly<{
  createReport?: (input: ReportPersistence) => Promise<ReportRecord>
  createNotification?: (input: ReportNotification) => Promise<unknown>
  reportSecondaryFailure?: (error: unknown) => void
}>

type PersistedNotification = { _id: { toString(): string } }

const notFound = () => new ApiProblem(404, 'RESOURCE_NOT_FOUND', 'Resource not found.')
const notAllowed = () =>
  new ApiProblem(403, 'REPORT_NOT_ALLOWED', 'This report action is not allowed.')

const requireRouteId = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) throw invalidInput(field)
  return new Types.ObjectId(value)
}

const defaultCreateReport = async (input: ReportPersistence) =>
  (await Report.create(input)) as unknown as ReportRecord
const defaultCreateNotification = (input: ReportNotification) => Notification.create(input)
const defaultReportSecondaryFailure = (error: unknown) => {
  console.error('Failed to persist Report confirmation notification', error)
}

const persistReport = async (
  input: ReportPersistence,
  dependencies: ReportServiceDependencies,
  messageId?: Types.ObjectId,
) => {
  const createReport = dependencies.createReport ?? defaultCreateReport
  const createNotification = dependencies.createNotification ?? defaultCreateNotification
  const reportSecondaryFailure =
    dependencies.reportSecondaryFailure ?? defaultReportSecondaryFailure
  const report = await createReport(input)

  try {
    const notification = await createNotification({
      recipientId: input.reporterUserId,
      type: 'report_submitted',
      reportId: report._id,
      ...(messageId ? { messageId } : {}),
    })
    if (
      typeof notification === 'object' &&
      notification !== null &&
      '_id' in notification &&
      notification._id &&
      typeof (notification._id as { toString?: unknown }).toString === 'function'
    ) {
      publishToUser(input.reporterUserId.toString(), 'notification.created', {
        notificationId: (notification as PersistedNotification)._id.toString(),
      })
    }
  } catch (error) {
    reportSecondaryFailure(error)
  }

  return report
}

const reportInput = (
  reporterUserId: Types.ObjectId,
  reportedUserId: Types.ObjectId,
  sourceType: ReportSourceType,
  request: ReportRequest,
  extra: Record<string, unknown> = {},
): ReportPersistence => ({
  reporterUserId,
  reportedUserId,
  reason: request.reason,
  ...(request.description ? { description: request.description } : {}),
  sourceType,
  ...extra,
})

export const submitProfileReport = async (
  reporterUserIdValue: string,
  targetUserIdValue: unknown,
  body: unknown,
  dependencies: ReportServiceDependencies = {},
) => {
  const request = parseReportRequest(body)
  const reporterUserId = new Types.ObjectId(reporterUserIdValue)
  const targetUserId = requireRouteId(targetUserIdValue, 'userId')
  const target = await User.findById(targetUserId).select('_id').lean()
  if (!target) throw notFound()
  if (reporterUserId.equals(target._id)) throw notAllowed()
  return persistReport(
    reportInput(reporterUserId, target._id, 'public_profile', request),
    dependencies,
  )
}

export const submitDirectConversationReport = async (
  reporterUserIdValue: string,
  conversationIdValue: unknown,
  body: unknown,
  dependencies: ReportServiceDependencies = {},
) => {
  const request = parseReportRequest(body)
  const reporterUserId = new Types.ObjectId(reporterUserIdValue)
  const conversationId = requireRouteId(conversationIdValue, 'conversationId')
  const conversation = await DirectConversation.findOne({
    _id: conversationId,
    participantIds: reporterUserId,
  })
    .select('_id participantIds')
    .lean()
  if (!conversation) throw notFound()
  const counterpartId = conversation.participantIds.find((id) => !id.equals(reporterUserId))
  if (!counterpartId) throw notFound()
  return persistReport(
    reportInput(reporterUserId, counterpartId, 'direct_conversation', request, {
      conversationId: conversation._id,
    }),
    dependencies,
  )
}

export const submitDirectMessageReport = async (
  reporterUserIdValue: string,
  messageIdValue: unknown,
  body: unknown,
  dependencies: ReportServiceDependencies = {},
) => {
  const request = parseReportRequest(body)
  const reporterUserId = new Types.ObjectId(reporterUserIdValue)
  const messageId = requireRouteId(messageIdValue, 'messageId')
  const message = await Message.findOne({ _id: messageId, contextType: 'direct' })
    .select('_id senderId contextId content createdAt')
    .lean()
  if (!message) throw notFound()

  const conversation = await DirectConversation.findOne({
    _id: message.contextId,
    participantIds: reporterUserId,
  })
    .select('_id participantIds')
    .lean()
  if (!conversation) throw notFound()
  const senderIsParticipant = conversation.participantIds.some((id) => id.equals(message.senderId))
  if (!senderIsParticipant) throw notFound()
  if (message.senderId.equals(reporterUserId)) throw notAllowed()

  const counterpartId = conversation.participantIds.find((id) => !id.equals(reporterUserId))
  if (!counterpartId || !counterpartId.equals(message.senderId)) throw notFound()

  return persistReport(
    reportInput(reporterUserId, message.senderId, 'direct_message', request, {
      conversationId: conversation._id,
      messageId: message._id,
      messageEvidence: {
        messageId: message._id,
        senderUserId: message.senderId,
        content: message.content,
        sentAt: message.createdAt,
      },
    }),
    dependencies,
    message._id,
  )
}
