import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import mongoose, { Types } from 'mongoose'
import {
  REPORT_EVIDENCE_ACCESS_AUDIT_IMMUTABLE_MESSAGE,
  ReportEvidenceAccessAuditEventModel,
} from '../dist/models/reportEvidenceAccessAuditEventModel.js'
import '../dist/models/announcementGovernanceEventModel.js'

const objectId = (suffix) => new Types.ObjectId(`0000000000000000000000${suffix}`)

const validEvent = () => ({
  actorUserId: objectId('11'),
  reportId: objectId('22'),
  evidenceMessageId: objectId('33'),
  eventType: 'report_evidence_access_attempt',
  attemptedAt: new Date('2026-10-17T10:00:00.000Z'),
  outcome: 'attempt_initiated',
})

describe('Report evidence access audit event model', () => {
  it('accepts only the minimal non-content event representation', async () => {
    const document = new ReportEvidenceAccessAuditEventModel(validEvent())
    await document.validate()
    assert.deepEqual(
      Object.keys(document.toObject()).sort(),
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
    assert.equal(document.eventType, 'report_evidence_access_attempt')
    assert.equal(document.outcome, 'attempt_initiated')
  })

  it('rejects missing actor and report identifiers', async () => {
    for (const missing of ['actorUserId', 'reportId']) {
      const input = validEvent()
      delete input[missing]
      await assert.rejects(() => new ReportEvidenceAccessAuditEventModel(input).validate())
    }
  })

  it('rejects unexpected and content-bearing fields in strict mode', () => {
    for (const [field, value] of [
      ['content', 'private message'],
      ['messageBody', 'private message'],
      ['reportDescription', 'sensitive description'],
      ['reporterProfile', { account: 'private' }],
      ['headers', { authorization: 'Bearer secret' }],
      ['email', 'member@example.com'],
      ['requestBody', { evidence: 'private message' }],
    ]) {
      assert.throws(
        () => new ReportEvidenceAccessAuditEventModel({ ...validEvent(), [field]: value }),
      )
    }
  })

  it('rejects query modification and deletion operations before database access', async () => {
    await assert.rejects(
      () => ReportEvidenceAccessAuditEventModel.updateOne({}, { $set: { outcome: 'changed' } }),
      new RegExp(REPORT_EVIDENCE_ACCESS_AUDIT_IMMUTABLE_MESSAGE),
    )
    await assert.rejects(
      () => ReportEvidenceAccessAuditEventModel.deleteOne({}),
      new RegExp(REPORT_EVIDENCE_ACCESS_AUDIT_IMMUTABLE_MESSAGE),
    )
  })

  it('remains isolated from the Announcement governance ledger', () => {
    const announcementGovernanceEventModel = mongoose.model('AnnouncementGovernanceEvent')
    assert.notEqual(
      ReportEvidenceAccessAuditEventModel.modelName,
      announcementGovernanceEventModel.modelName,
    )
    assert.notEqual(
      ReportEvidenceAccessAuditEventModel.collection.collectionName,
      announcementGovernanceEventModel.collection.collectionName,
    )
  })
})
