import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  IdentifierPolicyError,
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
} from '../dist/utils/identifierPolicy.js'

describe('Phase 9 identifier policy', () => {
  describe('Email identifiers', () => {
    it('trims the retained representation and lowercases only the canonical key', () => {
      assert.deepEqual(canonicalizeEmailIdentifier('  Mixed.Case+Tag@Example.COM  '), {
        representation: 'Mixed.Case+Tag@Example.COM',
        canonicalKey: 'mixed.case+tag@example.com',
      })
    })

    it('does not remove dots, plus tags, or apply provider aliases', () => {
      const result = canonicalizeEmailIdentifier('First.Last+Movune@GoogleMail.com')

      assert.equal(result.representation, 'First.Last+Movune@GoogleMail.com')
      assert.equal(result.canonicalKey, 'first.last+movune@googlemail.com')
    })

    it('is deterministic', () => {
      const input = '  Person+Label@Example.com '
      assert.deepEqual(canonicalizeEmailIdentifier(input), canonicalizeEmailIdentifier(input))
    })

    it('rejects empty, whitespace-only, and non-string input deterministically', () => {
      for (const input of ['', ' \t\r\n ', null, undefined, 42]) {
        assert.throws(
          () => canonicalizeEmailIdentifier(input),
          (error) => error instanceof IdentifierPolicyError && error.code === 'IDENTIFIER_INVALID',
        )
      }
    })
  })

  describe('Username identifiers', () => {
    it('accepts the locked Latin, Han, ASCII digit, and underscore repertoire', () => {
      for (const input of [
        'James',
        'james_01',
        'Jos\u00e9',
        'M\u00fcller',
        '\u96fb\u5f71',
        'James\u96fb\u5f71',
        '\u5f71\u8ff7_01',
      ]) {
        assert.doesNotThrow(() => canonicalizeUsernameIdentifier(input))
      }
    })

    it('preserves display casing and uses the v1 lowercase canonical key', () => {
      assert.deepEqual(canonicalizeUsernameIdentifier('JaMeS\u96fb\u5f71_01'), {
        representation: 'JaMeS\u96fb\u5f71_01',
        canonicalKey: 'james\u96fb\u5f71_01',
      })
      assert.equal(
        canonicalizeUsernameIdentifier('James').canonicalKey,
        canonicalizeUsernameIdentifier('jAmEs').canonicalKey,
      )
    })

    it('accepts canonically equivalent decomposed Latin after NFC normalization', () => {
      const composed = canonicalizeUsernameIdentifier('Jos\u00e9')
      const decomposed = canonicalizeUsernameIdentifier('Jose\u0301')

      assert.deepEqual(decomposed, composed)
      assert.equal(decomposed.representation, 'Jos\u00e9')
    })

    it('counts Unicode code points after NFC normalization', () => {
      assert.doesNotThrow(() => canonicalizeUsernameIdentifier('\u96fb\u5f71'))
      assert.doesNotThrow(() => canonicalizeUsernameIdentifier('a'.repeat(20)))
      assert.throws(() => canonicalizeUsernameIdentifier('a'), IdentifierPolicyError)
      assert.throws(() => canonicalizeUsernameIdentifier('a'.repeat(21)), IdentifierPolicyError)
    })

    it('rejects unsupported scripts, symbols, whitespace, and controls', () => {
      for (const input of [
        'James Smith',
        'James.Movie',
        'James-Movie',
        'James@Movie',
        'James\u{1f3ac}',
        '\u03b1lpha',
        '\u0430lpha',
        '\u3042name',
        'ab\u0000',
      ]) {
        assert.throws(() => canonicalizeUsernameIdentifier(input), IdentifierPolicyError)
      }
    })

    it('rejects invisible, fullwidth, compatibility, and unsupported combining input', () => {
      for (const input of ['\u200bJames', '\uff2aames', '\ufb00name', 'a\u0300\u0301']) {
        assert.throws(() => canonicalizeUsernameIdentifier(input), IdentifierPolicyError)
      }
    })

    it('is deterministic and stable when repeated with an accepted representation', () => {
      const input = 'M\u00fcller\u96fb\u5f71_01'
      const first = canonicalizeUsernameIdentifier(input)
      const second = canonicalizeUsernameIdentifier(input)
      const repeated = canonicalizeUsernameIdentifier(first.representation)

      assert.deepEqual(second, first)
      assert.deepEqual(repeated, first)
    })
  })
})
