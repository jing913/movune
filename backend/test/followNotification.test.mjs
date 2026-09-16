import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { persistFollowNotification } from '../dist/utils/followNotification.js'

const input = {
  recipientId: '64b64c0a4f4c6a2e9c6d1002',
  actorId: '64b64c0a4f4c6a2e9c6d1001',
  type: 'follow',
}

describe('Follow notification persistence policy', () => {
  it('attempts one notification after a Follow succeeds', async () => {
    let received
    await persistFollowNotification(input, async (notification) => {
      received = notification
    })

    assert.deepEqual(received, input)
  })

  it('reports notification failure without rejecting the successful Follow path', async () => {
    const expectedError = new Error('notification unavailable')
    let reported

    await assert.doesNotReject(() =>
      persistFollowNotification(
        input,
        async () => {
          throw expectedError
        },
        (error) => {
          reported = error
        },
      ),
    )
    assert.equal(reported, expectedError)
  })
})
