import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildPeopleSortStages, isPeopleSort } from '../dist/utils/peopleSort.js'

describe('People sorting policy', () => {
  it('allows only real discovery sorting options', () => {
    assert.equal(isPeopleSort('recent'), true)
    assert.equal(isPeopleSort('favorites'), false)
    assert.equal(isPeopleSort('account'), false)
    assert.equal(isPeopleSort('dna'), false)
  })

  it('sorts recent members deterministically', () => {
    assert.deepEqual(buildPeopleSortStages(), [{ $sort: { createdAt: -1, _id: -1 } }])
  })
})
