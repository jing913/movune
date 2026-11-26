import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  REPORT_EVIDENCE_SOURCE_PROJECTION,
  getAdminReportEvidence,
} from '../dist/services/adminReportEvidenceReadService.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const objectId = (suffix) => new Types.ObjectId(`0000000000000000000000${suffix}`)
const evaluatedAt = new Date('2035-08-15T12:00:00.000Z')
const actor = { _id: objectId('91'), role: 'admin' }
const content = 'Synthetic submitted message evidence'

const activeState = () => ({
  status: 'active',
  evaluatedAt,
  governingDecisionId: null,
  activeRestrictionDecisionIds: [],
  restrictionEndsAt: null,
})

const evidenceReport = (overrides = {}) => ({
  _id: objectId('21'),
  sourceType: 'direct_message',
  reportedUserId: objectId('11'),
  messageId: objectId('41'),
  messageEvidence: {
    messageId: objectId('41'),
    senderUserId: objectId('11'),
    content,
    sentAt: new Date('2035-08-01T08:30:00.000Z'),
  },
  ...overrides,
})

const repository = (value, calls = []) => ({
  async findReport(id, projection) {
    calls.push({ id, projection })
    return value
  },
})

const confirmedAuditRepository = (calls = []) => ({
  async append(event, options) {
    calls.push({ event, options })
    return { acknowledged: true, insertedId: event._id }
  },
})

const dependencies = (report, reportCalls = [], auditCalls = []) => ({
  repository: repository(report, reportCalls),
  audit: {
    repository: confirmedAuditRepository(auditCalls),
    loadAccountState: async () => activeState(),
  },
})

const isAuditFailureWithoutContent = (error) =>
  error instanceof ApiProblem &&
  error.code === 'REPORT_EVIDENCE_AUDIT_UNCONFIRMED' &&
  !JSON.stringify(error).includes(content)

describe('Admin bounded Report evidence read service', () => {
  it('returns only the submitted snapshot after a same-request confirmed audit append', async () => {
    const reportCalls = []
    const auditCalls = []
    const result = await getAdminReportEvidence(
      objectId('21').toString(),
      actor,
      evaluatedAt,
      dependencies(evidenceReport(), reportCalls, auditCalls),
    )

    assert.deepEqual(result, {
      evidence: {
        messageId: objectId('41').toString(),
        content,
        sentAt: '2035-08-01T08:30:00.000Z',
      },
    })
    assert.equal(reportCalls[0].projection, REPORT_EVIDENCE_SOURCE_PROJECTION)
    assert.equal(auditCalls.length, 1)
    assert.equal(auditCalls[0].event.actorUserId.toString(), actor._id.toString())
    assert.equal(auditCalls[0].event.reportId.toString(), objectId('21').toString())
    assert.equal(auditCalls[0].event.evidenceMessageId.toString(), objectId('41').toString())
    assert.equal(auditCalls[0].event.eventType, 'report_evidence_access_attempt')
    assert.equal(auditCalls[0].event.outcome, 'attempt_initiated')
    assert.equal(JSON.stringify(auditCalls[0].event).includes(content), false)
    assert.deepEqual(Object.keys(result.evidence).sort(), ['content', 'messageId', 'sentAt'])
  })

  it('authorizes before reading the Report and ignores forged client capability fields', async () => {
    const reportCalls = []
    const auditCalls = []
    await assert.rejects(
      () =>
        getAdminReportEvidence(
          objectId('21').toString(),
          { _id: objectId('92'), role: 'user', viewReports: true },
          evaluatedAt,
          dependencies(evidenceReport(), reportCalls, auditCalls),
        ),
      (error) => error?.status === 403 && error?.code === 'REPORT_REVIEW_FORBIDDEN',
    )
    assert.equal(reportCalls.length, 0)
    assert.equal(auditCalls.length, 0)
  })

  it('fails closed without returning content on rejection, malformed acknowledgment, or timeout', async () => {
    const cases = [
      {
        append: async () => {
          throw new Error(`database failed while handling ${content}`)
        },
      },
      { append: async () => ({ acknowledged: false }) },
      { append: async () => ({ acknowledged: true, insertedId: objectId('99') }) },
      { append: () => new Promise(() => {}) },
    ]
    for (const [index, auditRepository] of cases.entries()) {
      let attempts = 0
      await assert.rejects(
        () =>
          getAdminReportEvidence(objectId('21').toString(), actor, evaluatedAt, {
            repository: repository(evidenceReport()),
            audit: {
              repository: {
                async append(...args) {
                  attempts += 1
                  return auditRepository.append(...args)
                },
              },
              loadAccountState: async () => activeState(),
              ...(index === 3 ? { operationTimeoutMs: 5 } : {}),
            },
          }),
        isAuditFailureWithoutContent,
      )
      assert.equal(attempts, 1)
    }
  })

  it('returns controlled unavailability without querying messages or appending an audit', async () => {
    for (const report of [
      { _id: objectId('21'), sourceType: 'public_profile' },
      { _id: objectId('21'), sourceType: 'direct_conversation' },
      evidenceReport({ messageId: undefined, messageEvidence: undefined }),
    ]) {
      const auditCalls = []
      await assert.rejects(
        () =>
          getAdminReportEvidence(
            objectId('21').toString(),
            actor,
            evaluatedAt,
            dependencies(report, [], auditCalls),
          ),
        (error) =>
          error?.code === 'ADMIN_REPORT_EVIDENCE_UNAVAILABLE' ||
          error?.code === 'ADMIN_REPORT_EVIDENCE_INVALID',
      )
      assert.equal(auditCalls.length, 0)
    }
  })

  it('rejects mismatched or malformed snapshots before auditing or disclosure', async () => {
    for (const report of [
      evidenceReport({
        messageEvidence: {
          ...evidenceReport().messageEvidence,
          messageId: objectId('42'),
        },
      }),
      evidenceReport({
        messageEvidence: {
          ...evidenceReport().messageEvidence,
          senderUserId: objectId('12'),
        },
      }),
      evidenceReport({
        messageEvidence: { ...evidenceReport().messageEvidence, content: '' },
      }),
      evidenceReport({
        messageEvidence: { ...evidenceReport().messageEvidence, sentAt: new Date('invalid') },
      }),
    ]) {
      const auditCalls = []
      await assert.rejects(
        () =>
          getAdminReportEvidence(
            objectId('21').toString(),
            actor,
            evaluatedAt,
            dependencies(report, [], auditCalls),
          ),
        (error) =>
          error?.status === 500 &&
          error?.code === 'ADMIN_REPORT_EVIDENCE_INVALID' &&
          !JSON.stringify(error).includes(content),
      )
      assert.equal(auditCalls.length, 0)
    }
  })

  it('authorizes then validates the Report id before repository access and handles absence safely', async () => {
    const reportCalls = []
    let accountLoads = 0
    await assert.rejects(
      () =>
        getAdminReportEvidence('not-an-id', actor, evaluatedAt, {
          repository: repository(evidenceReport(), reportCalls),
          audit: {
            repository: confirmedAuditRepository(),
            loadAccountState: async () => {
              accountLoads += 1
              return activeState()
            },
          },
        }),
      (error) => error?.status === 400 && error?.code === 'ADMIN_REPORT_ID_INVALID',
    )
    assert.equal(reportCalls.length, 0)
    assert.equal(accountLoads, 1)

    await assert.rejects(
      () =>
        getAdminReportEvidence(objectId('21').toString(), actor, evaluatedAt, {
          repository: repository(null),
          audit: {
            repository: confirmedAuditRepository(),
            loadAccountState: async () => activeState(),
          },
        }),
      (error) => error?.status === 404 && error?.code === 'ADMIN_REPORT_NOT_FOUND',
    )
  })
})
