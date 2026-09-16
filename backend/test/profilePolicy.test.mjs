import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProfileUpdate } from '../dist/utils/profilePolicy.js'

test('profile update trims supported public fields and strips unrelated values', async () => {
  const profile = await parseProfileUpdate({
    displayName: '  Film Friend  ',
    bio: '  Loves practical effects.  ',
    account: 'must-not-change',
    role: 'admin',
  })

  assert.deepEqual(profile, {
    displayName: 'Film Friend',
    bio: 'Loves practical effects.',
  })
})

test('profile update enforces display name and bio length limits', async () => {
  await assert.rejects(() => parseProfileUpdate({ displayName: 'A', bio: '' }))
  await assert.rejects(() =>
    parseProfileUpdate({ displayName: 'Valid name', bio: 'x'.repeat(161) }),
  )
})
