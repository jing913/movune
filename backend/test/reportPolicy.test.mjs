import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseReportRequest, REPORT_DESCRIPTION_MAX_LENGTH } from '../dist/utils/reportPolicy.js'

const problem = (code, field) => (error) => error?.code === code && error?.details?.field === field

describe('Official Stage 8 Report request policy', () => {
  it('accepts only the canonical reasons', () => {
    for (const reason of ['harassment_or_uncomfortable', 'spam_or_suspicious', 'other']) {
      assert.deepEqual(parseReportRequest({ reason }), { reason })
    }
  })

  it('normalizes optional descriptions by Unicode code point', () => {
    assert.deepEqual(parseReportRequest({ reason: 'other', description: '  context  ' }), {
      reason: 'other',
      description: 'context',
    })
    assert.deepEqual(parseReportRequest({ reason: 'other', description: '   ' }), {
      reason: 'other',
    })
    const maximum = '🎬'.repeat(REPORT_DESCRIPTION_MAX_LENGTH)
    assert.equal(parseReportRequest({ reason: 'other', description: maximum }).description, maximum)
    assert.throws(
      () => parseReportRequest({ reason: 'other', description: `${maximum}🎬` }),
      problem('INVALID_INPUT', 'description'),
    )
  })

  it('rejects missing and malformed bodies without echoing values', () => {
    for (const body of [undefined, null, [], 'text', 1, true, {}]) {
      assert.throws(() => parseReportRequest(body), problem('INVALID_INPUT', 'reason'))
    }
    for (const reason of ['invalid-never-echo', false, 1, null, [], {}]) {
      assert.throws(
        () => parseReportRequest({ reason }),
        (error) =>
          problem('REPORT_INVALID_REASON', 'reason')(error) &&
          !JSON.stringify(error).includes('invalid-never-echo'),
      )
    }
  })

  it('rejects every non-string description and every unknown field', () => {
    for (const description of [null, false, 1, [], {}]) {
      assert.throws(
        () => parseReportRequest({ reason: 'other', description }),
        problem('INVALID_INPUT', 'description'),
      )
    }
    assert.throws(
      () => parseReportRequest({ reason: 'other', reportedUserId: 'never-echo' }),
      (error) =>
        problem('INVALID_INPUT', 'body')(error) && !JSON.stringify(error).includes('never-echo'),
    )
  })
})
