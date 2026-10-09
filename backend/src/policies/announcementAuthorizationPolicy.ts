import {
  isAnnouncementHistoricalBackfillAdminUserId,
  isAnnouncementRemoveAdminUserId,
} from '../configs/announcementAuthorization.js'

export const ANNOUNCEMENT_PERMISSIONS = [
  'announcement:create',
  'announcement:edit',
  'announcement:publish',
  'announcement:historical_backfill',
  'announcement:withdraw',
  'announcement:restore',
  'announcement:remove',
] as const

export type AnnouncementPermission = (typeof ANNOUNCEMENT_PERMISSIONS)[number]

export const STANDARD_ANNOUNCEMENT_PERMISSIONS = [
  'announcement:create',
  'announcement:edit',
  'announcement:publish',
  'announcement:withdraw',
  'announcement:restore',
] as const satisfies readonly AnnouncementPermission[]

export type AnnouncementAuthorizationIdentity = Readonly<{
  _id: string | Readonly<{ toString(): string }>
  role: 'user' | 'admin'
}>

export type AnnouncementCapabilities = Readonly<{
  manageAnnouncements: boolean
}>

export type AnnouncementRemoveAdminMembership = (userId: string) => boolean
export type AnnouncementHistoricalBackfillAdminMembership = (userId: string) => boolean

const hasStandardPermission = (permission: string) =>
  (STANDARD_ANNOUNCEMENT_PERMISSIONS as readonly string[]).includes(permission)

export const isAnnouncementAuthorized = (
  user: AnnouncementAuthorizationIdentity | null | undefined,
  permission: string,
  isElevatedRemoveAdmin: AnnouncementRemoveAdminMembership = isAnnouncementRemoveAdminUserId,
  isHistoricalBackfillAdmin: AnnouncementHistoricalBackfillAdminMembership = isAnnouncementHistoricalBackfillAdminUserId,
) => {
  if (!user || user.role !== 'admin') return false
  if (hasStandardPermission(permission)) return true
  if (permission === 'announcement:historical_backfill') {
    return isHistoricalBackfillAdmin(user._id.toString().toLowerCase())
  }
  if (permission !== 'announcement:remove') return false

  return isElevatedRemoveAdmin(user._id.toString().toLowerCase())
}

export const deriveAnnouncementCapabilities = (
  user: AnnouncementAuthorizationIdentity | null | undefined,
): AnnouncementCapabilities => ({
  manageAnnouncements: STANDARD_ANNOUNCEMENT_PERMISSIONS.every((permission) =>
    isAnnouncementAuthorized(user, permission),
  ),
})
