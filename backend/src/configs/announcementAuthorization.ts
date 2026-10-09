import { isObjectIdOrHexString, Types } from 'mongoose'

export const ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV = 'ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS'
export const ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV =
  'ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS'

export class AnnouncementAuthorizationConfigurationError extends Error {
  readonly code = 'ANNOUNCEMENT_AUTHORIZATION_CONFIGURATION_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'AnnouncementAuthorizationConfigurationError'
  }
}

export const parseAnnouncementRemoveAdminUserIds = (
  input: string | undefined,
): ReadonlySet<string> => {
  if (input === undefined || input.trim() === '') return new Set()

  const values = input.split(',').map((value) => value.trim())
  if (values.some((value) => value === '' || !isObjectIdOrHexString(value))) {
    throw new AnnouncementAuthorizationConfigurationError(
      `${ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV} must contain only MongoDB ObjectIds`,
    )
  }

  return new Set(values.map((value) => new Types.ObjectId(value).toHexString()))
}

export const parseAnnouncementHistoricalBackfillAdminUserIds = (
  input: string | undefined,
): ReadonlySet<string> => {
  if (input === undefined || input.trim() === '') return new Set()

  const values = input.split(',').map((value) => value.trim())
  if (values.some((value) => value === '' || !isObjectIdOrHexString(value))) {
    throw new AnnouncementAuthorizationConfigurationError(
      `${ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV} must contain only MongoDB ObjectIds`,
    )
  }

  return new Set(values.map((value) => new Types.ObjectId(value).toHexString()))
}

const announcementRemoveAdminUserIds = parseAnnouncementRemoveAdminUserIds(
  process.env[ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV],
)
const announcementHistoricalBackfillAdminUserIds = parseAnnouncementHistoricalBackfillAdminUserIds(
  process.env[ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV],
)

export const isAnnouncementRemoveAdminUserId = (userId: string) =>
  announcementRemoveAdminUserIds.has(userId.toLowerCase())

export const isAnnouncementHistoricalBackfillAdminUserId = (userId: string) =>
  announcementHistoricalBackfillAdminUserIds.has(userId.toLowerCase())
