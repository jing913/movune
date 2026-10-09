import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as productionConfiguration from '../dist/configs/announcementAuthorization.js'
import {
  ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV,
  ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV,
  AnnouncementAuthorizationConfigurationError,
  parseAnnouncementHistoricalBackfillAdminUserIds,
  parseAnnouncementRemoveAdminUserIds,
} from '../dist/configs/announcementAuthorization.js'

const firstId = '507f1f77bcf86cd799439011'
const secondId = '507F191E810C19729DE860EA'

describe('P10-I2 Announcement authorization configuration', () => {
  it('fails closed for absent, empty, and malformed historical-backfill configuration', () => {
    for (const input of [undefined, '', '   \t  ']) {
      assert.deepEqual([...parseAnnouncementHistoricalBackfillAdminUserIds(input)], [])
    }
    for (const input of ['not-an-object-id', `${firstId},bad`, `${firstId},`]) {
      assert.throws(
        () => parseAnnouncementHistoricalBackfillAdminUserIds(input),
        AnnouncementAuthorizationConfigurationError,
      )
    }
  })

  it('normalizes historical-backfill IDs without exporting the runtime allowlist', async () => {
    const previousValue = process.env[ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV]
    process.env[ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV] = secondId
    try {
      const configuredModule = await import(
        `../dist/configs/announcementAuthorization.js?historical-boundary=${Date.now()}`
      )
      assert.equal(configuredModule.isAnnouncementHistoricalBackfillAdminUserId(secondId), true)
      assert.equal(configuredModule.isAnnouncementHistoricalBackfillAdminUserId(firstId), false)
      assert.equal('announcementHistoricalBackfillAdminUserIds' in configuredModule, false)
      assert.equal(
        Object.values(configuredModule).some((value) => value instanceof Set),
        false,
      )
    } finally {
      if (previousValue === undefined) {
        delete process.env[ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV]
      } else {
        process.env[ANNOUNCEMENT_HISTORICAL_BACKFILL_ADMIN_USER_IDS_ENV] = previousValue
      }
    }
  })

  it('treats absent, empty, and whitespace-only configuration as an empty allowlist', () => {
    for (const input of [undefined, '', '   \t  ']) {
      assert.deepEqual([...parseAnnouncementRemoveAdminUserIds(input)], [])
    }
  })

  it('accepts one or multiple ObjectIds and normalizes surrounding whitespace', () => {
    assert.deepEqual([...parseAnnouncementRemoveAdminUserIds(firstId)], [firstId])
    assert.deepEqual(
      [...parseAnnouncementRemoveAdminUserIds(` ${firstId}, ${secondId} `)],
      [firstId, secondId.toLowerCase()],
    )
  })

  it('deduplicates normalized ObjectIds', () => {
    assert.deepEqual(
      [...parseAnnouncementRemoveAdminUserIds(`${secondId},${secondId.toLowerCase()}`)],
      [secondId.toLowerCase()],
    )
  })

  it('fails the whole configuration for malformed or mixed values', () => {
    for (const input of ['not-an-object-id', `${firstId},not-an-object-id`, `${firstId},`]) {
      assert.throws(
        () => parseAnnouncementRemoveAdminUserIds(input),
        (error) =>
          error instanceof AnnouncementAuthorizationConfigurationError &&
          error.code === 'ANNOUNCEMENT_AUTHORIZATION_CONFIGURATION_INVALID',
      )
    }
  })

  it('exposes membership behavior without exposing the authoritative runtime Set', async () => {
    const previousValue = process.env[ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV]
    process.env[ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV] = firstId

    try {
      const configuredModule = await import(
        `../dist/configs/announcementAuthorization.js?runtime-boundary=${Date.now()}`
      )

      assert.equal(configuredModule.isAnnouncementRemoveAdminUserId(firstId), true)
      assert.equal(configuredModule.isAnnouncementRemoveAdminUserId(secondId), false)
      assert.equal('announcementRemoveAdminUserIds' in configuredModule, false)
      assert.equal(
        Object.values(configuredModule).some((value) => value instanceof Set),
        false,
      )
      assert.equal(
        Object.values(productionConfiguration).some((value) => value instanceof Set),
        false,
      )
    } finally {
      if (previousValue === undefined) delete process.env[ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV]
      else process.env[ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS_ENV] = previousValue
    }
  })
})
