import type { HydratedDocument } from 'mongoose'
import type { IUser } from '../models/userModel.js'
import { normalizeMessageRequestPreference } from './contactAuthorizationContextService.js'
import type { MessageRequestPreference } from '../utils/contactAuthorizationPolicy.js'
import { ApiProblem, invalidInput } from '../utils/messagingPolicy.js'

export type PrivacyDto = Readonly<{
  privacy: Readonly<{
    messageRequestPreference: MessageRequestPreference
  }>
}>

const privacyPreferenceInvalid = (status: 400 | 500, includeField: boolean) =>
  new ApiProblem(
    status,
    'PRIVACY_PREFERENCE_INVALID',
    'Messaging privacy preference is invalid.',
    includeField ? { field: 'messageRequestPreference' } : undefined,
  )

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export const parsePrivacyUpdate = (body: unknown): MessageRequestPreference => {
  if (!isPlainObject(body)) throw invalidInput('messageRequestPreference')

  const keys = Object.keys(body)
  if (keys.some((key) => key !== 'messageRequestPreference')) throw invalidInput('body')
  if (keys.length !== 1) throw invalidInput('messageRequestPreference')

  const value = body.messageRequestPreference
  if (value !== 'all_members' && value !== 'followed_members') {
    throw privacyPreferenceInvalid(400, true)
  }
  return value
}

export const serializeMessagingPrivacy = (value: unknown): PrivacyDto => {
  const normalized = normalizeMessageRequestPreference(value)
  if (normalized === 'invalid') throw privacyPreferenceInvalid(500, false)
  return { privacy: { messageRequestPreference: normalized } }
}

export const readMessagingPrivacy = (user: Pick<IUser, 'messageRequestPreference'>) =>
  serializeMessagingPrivacy(user.messageRequestPreference)

export const updateMessagingPrivacy = async (
  user: HydratedDocument<IUser>,
  body: unknown,
): Promise<PrivacyDto> => {
  user.messageRequestPreference = parsePrivacyUpdate(body)
  await user.save()
  return serializeMessagingPrivacy(user.messageRequestPreference)
}
