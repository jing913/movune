import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ANNOUNCEMENT_EFFECTIVE_AT_BASES,
  ANNOUNCEMENT_HISTORICAL_TIME_ZONE,
  formatAnnouncementEffectiveDate,
  normalizeAnnouncementEffectiveDate,
} from '../dist/utils/announcementHistoricalPolicy.js'

describe('Historical Announcement logical date policy', () => {
  it('locks the timezone and the sole authorized basis', () => {
    assert.equal(ANNOUNCEMENT_HISTORICAL_TIME_ZONE, 'Asia/Taipei')
    assert.deepEqual(ANNOUNCEMENT_EFFECTIVE_AT_BASES, ['production_verified_no_later_than'])
  })

  it('normalizes the frozen logical date to Taipei start-of-day and round-trips it', () => {
    const normalized = normalizeAnnouncementEffectiveDate('2026-10-06')
    assert.equal(normalized.toISOString(), '2026-10-05T16:00:00.000Z')
    assert.equal(formatAnnouncementEffectiveDate(normalized), '2026-10-06')
  })

  it('rejects non-canonical, malformed, and impossible dates', () => {
    for (const invalid of [
      '2026-1-06',
      '2026-10-6',
      '2026/10/06',
      '2026-10-06T00:00:00.000Z',
      '2026-02-29',
      '2026-04-31',
      'not-a-date',
      '',
    ]) {
      assert.throws(() => normalizeAnnouncementEffectiveDate(invalid), RangeError)
    }
  })
})
