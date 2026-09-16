import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  buildCollectionSummaryProjection,
  shapeOwnerCollectionSummary,
  shapeVisitorCollectionSummary,
} from '../dist/services/collectionService.js'

const collection = (values = {}) => ({
  _id: new Types.ObjectId(),
  name: 'Cinema journal',
  description: null,
  visibility: 'private',
  ...values,
})

const membership = (tmdbId, position, _id = new Types.ObjectId()) => ({
  _id,
  tmdbId,
  position,
})

describe('Collection summary projection', () => {
  it('returns exact empty, one-item, two-item, and three-item previews', () => {
    assert.deepEqual(buildCollectionSummaryProjection([]), { movieCount: 0, previewMovies: [] })
    assert.deepEqual(buildCollectionSummaryProjection([membership(11, 0)]), {
      movieCount: 1,
      previewMovies: [{ tmdbId: 11 }],
    })
    assert.deepEqual(buildCollectionSummaryProjection([membership(22, 1), membership(21, 0)]), {
      movieCount: 2,
      previewMovies: [{ tmdbId: 21 }, { tmdbId: 22 }],
    })
    assert.deepEqual(
      buildCollectionSummaryProjection([membership(33, 2), membership(31, 0), membership(32, 1)]),
      {
        movieCount: 3,
        previewMovies: [{ tmdbId: 31 }, { tmdbId: 32 }, { tmdbId: 33 }],
      },
    )
  })

  it('counts every membership while returning only the first three in deterministic order', () => {
    const firstTieId = new Types.ObjectId()
    const secondTieId = new Types.ObjectId()
    assert.deepEqual(
      buildCollectionSummaryProjection([
        membership(44, 3),
        membership(43, 1, secondTieId),
        membership(41, 0),
        membership(42, 1, firstTieId),
      ]),
      {
        movieCount: 4,
        previewMovies: [{ tmdbId: 41 }, { tmdbId: 42 }, { tmdbId: 43 }],
      },
    )
  })

  it('uses separate allowlisted owner and visitor DTOs', () => {
    const projection = { movieCount: 1, previewMovies: [{ tmdbId: 550 }] }
    const source = collection({
      description: 'Personal notes',
      visibility: 'public',
      ownerId: new Types.ObjectId(),
      lifecycleState: 'active',
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 7,
      favoritesPublic: false,
      matchScore: 1,
    })

    assert.deepEqual(shapeOwnerCollectionSummary(source, projection), {
      _id: source._id,
      name: 'Cinema journal',
      description: 'Personal notes',
      visibility: 'public',
      movieCount: 1,
      previewMovies: [{ tmdbId: 550 }],
    })
    assert.deepEqual(shapeVisitorCollectionSummary(source, projection), {
      _id: source._id,
      name: 'Cinema journal',
      description: 'Personal notes',
      movieCount: 1,
      previewMovies: [{ tmdbId: 550 }],
    })
  })
})
