import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  REPORT_EVIDENCE_AUDIT_OPERATION_TIMEOUT_MS,
  REPORT_EVIDENCE_AUDIT_WRITE_CONCERN,
  appendReportEvidenceAccessAudit,
  confirmReportEvidenceDisclosureGate,
} from '../dist/services/reportEvidenceAccessAuditService.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const actorUserId = '000000000000000000000011'
const reportId = '000000000000000000000022'
const evidenceMessageId = '000000000000000000000033'
const attemptedAt = new Date('2026-10-17T10:00:00.000Z')

const input = () => ({ actorUserId, reportId, evidenceMessageId, attemptedAt })

const activeState = (evaluatedAt) => ({
  status: 'active',
  governingDecisionId: null,
  activeRestrictionDecisionIds: [],
  restrictionEndsAt: null,
  evaluatedAt,
})

const isSafeFailure = (error) =>
  error instanceof ApiProblem &&
  error.status === 503 &&
  error.code === 'REPORT_EVIDENCE_AUDIT_UNCONFIRMED' &&
  error.message === 'Protected evidence access is unavailable' &&
  !JSON.stringify(error).includes('private') &&
  !JSON.stringify(error).includes('topology')

const confirmedRepository = (calls) => ({
  async append(event, options) {
    calls.push({ event, options })
    return { acknowledged: true, insertedId: event._id }
  },
})

describe('Report evidence access audit append service', () => {
  it('persists a minimal attempt event with the required durable write policy', async () => {
    const calls = []
    const result = await appendReportEvidenceAccessAudit(input(), {
      repository: confirmedRepository(calls),
    })

    assert.deepEqual(result, {
      status: 'audit-append-confirmed',
      disclosurePermission: 'granted',
    })
    assert.equal(Object.isFrozen(result), true)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].options.writeConcern, {
      w: 'majority',
      journal: true,
      wtimeoutMS: 5_000,
    })
    assert.equal(calls[0].options.timeoutMS, REPORT_EVIDENCE_AUDIT_OPERATION_TIMEOUT_MS)
    assert.deepEqual(REPORT_EVIDENCE_AUDIT_WRITE_CONCERN, calls[0].options.writeConcern)
    assert.deepEqual(
      Object.keys(calls[0].event).sort(),
      [
        '_id',
        'actorUserId',
        'attemptedAt',
        'eventType',
        'evidenceMessageId',
        'outcome',
        'reportId',
      ].sort(),
    )
    assert.equal(calls[0].event.eventType, 'report_evidence_access_attempt')
    assert.equal(calls[0].event.outcome, 'attempt_initiated')
    assert.equal('deliverySucceeded' in calls[0].event, false)
    assert.equal('viewed' in calls[0].event, false)
  })

  it('rejects missing identifiers and every unexpected content-bearing field before persistence', async () => {
    const calls = []
    const repository = confirmedRepository(calls)
    for (const missing of ['actorUserId', 'reportId', 'evidenceMessageId']) {
      const candidate = input()
      delete candidate[missing]
      await assert.rejects(
        () => appendReportEvidenceAccessAudit(candidate, { repository }),
        isSafeFailure,
      )
    }
    for (const [field, value] of [
      ['content', 'private message'],
      ['reportDescription', 'private report'],
      ['requestBody', { message: 'private message' }],
      ['authorization', 'Bearer secret'],
      ['email', 'private@example.com'],
    ]) {
      await assert.rejects(
        () => appendReportEvidenceAccessAudit({ ...input(), [field]: value }, { repository }),
        isSafeFailure,
      )
    }
    assert.equal(calls.length, 0)
  })

  it('fails closed on database rejection without leaking infrastructure or evidence details', async () => {
    let attempts = 0
    await assert.rejects(
      () =>
        appendReportEvidenceAccessAudit(input(), {
          repository: {
            async append() {
              attempts += 1
              throw new Error('topology unavailable while writing private message')
            },
          },
        }),
      isSafeFailure,
    )
    assert.equal(attempts, 1)
  })

  it('fails closed on timeout or unknown outcome and does not retry', async () => {
    let attempts = 0
    await assert.rejects(
      () =>
        appendReportEvidenceAccessAudit(input(), {
          repository: {
            append() {
              attempts += 1
              return new Promise(() => {})
            },
          },
          operationTimeoutMs: 5,
        }),
      isSafeFailure,
    )
    assert.equal(attempts, 1)
  })

  it('rejects malformed, incomplete, unacknowledged, or mismatched acknowledgments', async () => {
    for (const acknowledgment of [
      undefined,
      {},
      { acknowledged: false },
      { acknowledged: true },
      { acknowledged: true, insertedId: new Types.ObjectId() },
    ]) {
      let attempts = 0
      await assert.rejects(
        () =>
          appendReportEvidenceAccessAudit(input(), {
            repository: {
              async append() {
                attempts += 1
                return acknowledgment
              },
            },
          }),
        isSafeFailure,
      )
      assert.equal(attempts, 1)
    }
  })
})

describe('Report evidence disclosure gate foundation', () => {
  it('requires independent Report Review authorization before the confirmed audit append', async () => {
    const calls = []
    const result = await confirmReportEvidenceDisclosureGate(
      {
        actor: { _id: actorUserId, role: 'admin' },
        reportId,
        evidenceMessageId,
      },
      {
        now: () => attemptedAt,
        loadAccountState: async (_id, evaluatedAt) => activeState(evaluatedAt),
        repository: confirmedRepository(calls),
      },
    )
    assert.equal(result.disclosurePermission, 'granted')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].event.actorUserId.toString(), actorUserId)
    assert.deepEqual(calls[0].event.attemptedAt, attemptedAt)
  })

  it('does not trust client-fabricated capability or audit-result fields', async () => {
    let appendAttempts = 0
    await assert.rejects(
      () =>
        confirmReportEvidenceDisclosureGate(
          {
            actor: { _id: actorUserId, role: 'user', viewReports: true },
            reportId,
            evidenceMessageId,
          },
          {
            now: () => attemptedAt,
            loadAccountState: async (_id, evaluatedAt) => activeState(evaluatedAt),
            repository: {
              async append() {
                appendAttempts += 1
                return { acknowledged: true, insertedId: new Types.ObjectId() }
              },
            },
          },
        ),
      (error) => error instanceof ApiProblem && error.code === 'REPORT_REVIEW_FORBIDDEN',
    )
    assert.equal(appendAttempts, 0)

    await assert.rejects(
      () =>
        confirmReportEvidenceDisclosureGate(
          {
            actor: { _id: actorUserId, role: 'admin' },
            reportId,
            evidenceMessageId,
            auditConfirmed: true,
          },
          {
            now: () => attemptedAt,
            loadAccountState: async (_id, evaluatedAt) => activeState(evaluatedAt),
            repository: confirmedRepository([]),
          },
        ),
      isSafeFailure,
    )
  })

  it('grants no disclosure permission when the audit result is failed or uncertain', async () => {
    for (const repository of [
      { append: async () => ({ acknowledged: false }) },
      { append: async () => Promise.reject(new Error('unknown outcome')) },
    ]) {
      await assert.rejects(
        () =>
          confirmReportEvidenceDisclosureGate(
            {
              actor: { _id: actorUserId, role: 'admin' },
              reportId,
              evidenceMessageId,
            },
            {
              now: () => attemptedAt,
              loadAccountState: async (_id, evaluatedAt) => activeState(evaluatedAt),
              repository,
            },
          ),
        isSafeFailure,
      )
    }
  })
})
