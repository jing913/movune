import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Schema, Types } from 'mongoose'
import { IdentifierClaim } from '../dist/models/identifierClaimModel.js'

const validClaim = (overrides = {}) =>
  new IdentifierClaim({
    kind: 'email',
    canonicalKey: 'member@example.com',
    ownerUserId: new Types.ObjectId(),
    state: 'active',
    ...overrides,
  })

describe('Phase 9 IdentifierClaim persistence metadata', () => {
  it('requires every live I1 field', async () => {
    for (const field of ['kind', 'canonicalKey', 'ownerUserId', 'state']) {
      await assert.rejects(
        () => validClaim({ [field]: undefined }).validate(),
        (error) => error?.errors[field]?.kind === 'required',
      )
    }
  })

  it('accepts only the locked kinds and live states without a state default', async () => {
    for (const kind of ['email', 'username']) {
      await assert.doesNotReject(() => validClaim({ kind }).validate())
    }
    for (const state of ['active', 'reserved']) {
      await assert.doesNotReject(() => validClaim({ state }).validate())
    }

    await assert.rejects(() => validClaim({ kind: 'account' }).validate())
    await assert.rejects(() => validClaim({ state: 'released' }).validate())
    assert.equal(IdentifierClaim.schema.path('state').options.default, undefined)
  })

  it('uses an immutable User ObjectId owner reference and immutable namespace fields', () => {
    const ownerPath = IdentifierClaim.schema.path('ownerUserId')

    assert.equal(ownerPath.instance, 'ObjectId')
    assert.equal(ownerPath.options.type, Schema.Types.ObjectId)
    assert.equal(ownerPath.options.ref, 'User')
    assert.equal(ownerPath.options.immutable, true)
    assert.equal(IdentifierClaim.schema.path('kind').options.immutable, true)
    assert.equal(IdentifierClaim.schema.path('canonicalKey').options.immutable, true)
    assert.notEqual(IdentifierClaim.schema.path('state').options.immutable, true)
  })

  it('enables timestamps and disables automatic collection and index creation', () => {
    assert.equal(IdentifierClaim.schema.options.timestamps, true)
    assert.equal(IdentifierClaim.schema.path('createdAt').instance, 'Date')
    assert.equal(IdentifierClaim.schema.path('updatedAt').instance, 'Date')
    assert.equal(IdentifierClaim.schema.options.autoIndex, false)
    assert.equal(IdentifierClaim.schema.options.autoCreate, false)
  })

  it('omits deferred lifecycle fields and a live released state', () => {
    const paths = new Set(Object.keys(IdentifierClaim.schema.paths))
    for (const field of ['reservedAt', 'releaseNotBefore', 'deletionId', 'deletionVersion']) {
      assert.equal(paths.has(field), false)
    }
    assert.deepEqual(IdentifierClaim.schema.path('state').options.enum, ['active', 'reserved'])
  })

  it('declares the unique namespace index without a TTL index', () => {
    const indexes = IdentifierClaim.schema.indexes()

    assert.ok(
      indexes.some(
        ([fields, options]) =>
          fields.kind === 1 && fields.canonicalKey === 1 && options.unique === true,
      ),
    )
    assert.equal(
      indexes.some(([, options]) => 'expireAfterSeconds' in options),
      false,
    )
  })

  it('does not apply schema-side canonicalization to canonicalKey', () => {
    const options = IdentifierClaim.schema.path('canonicalKey').options

    assert.equal(options.trim, undefined)
    assert.equal(options.lowercase, undefined)
    assert.equal(options.set, undefined)
  })
})
