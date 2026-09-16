import { Collection } from '../models/collectionModel.js'
import { CollectionMembership } from '../models/collectionMembershipModel.js'
import mongoose, { type ClientSession, type Types } from 'mongoose'
import {
  canManageCollection,
  canRecoverCollection,
  canViewCollection,
  canViewCollectionMembership,
} from '../utils/collectionAuthorizationPolicy.js'
import type {
  AddCollectionMembershipInput,
  CreateCollectionInput,
  ReorderCollectionMembershipsInput,
  UpdateCollectionInput,
} from '../utils/collectionValidation.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

const { connection } = mongoose

type CollectionValue = {
  _id: Types.ObjectId
  ownerId: Types.ObjectId
  name: string
  description?: string | null
  visibility: 'private' | 'public'
  lifecycleState: 'active' | 'deleted'
  deletedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

type CollectionMembershipValue = {
  tmdbId: number
  position: number
}

export type CollectionPreviewMovie = {
  tmdbId: number
}

type CollectionSummaryValue = Pick<CollectionValue, '_id' | 'name' | 'description' | 'visibility'>

type DeletedCollectionValue = Pick<CollectionValue, '_id' | 'name' | 'description' | 'deletedAt'>

type CollectionSummaryProjection = {
  movieCount: number
  previewMovies: CollectionPreviewMovie[]
}

export type OwnerCollectionSummary = {
  _id: Types.ObjectId
  name: string
  description?: string
  visibility: 'private' | 'public'
  movieCount: number
  previewMovies: CollectionPreviewMovie[]
}

export type PublicCollectionSummary = Omit<OwnerCollectionSummary, 'visibility'>

export type OwnerDeletedCollectionSummary = {
  _id: Types.ObjectId
  name: string
  description?: string
  deletedAt: Date | null
}

type PersistedCollectionMembership = CollectionMembershipValue & {
  _id: Types.ObjectId
}

type CollectionSummaryMembership = PersistedCollectionMembership & {
  collectionId: Types.ObjectId
}

const membershipDto = ({ tmdbId, position }: CollectionMembershipValue) => ({ tmdbId, position })

export const shapeOwnerCollection = (
  collection: CollectionValue,
  memberships?: CollectionMembershipValue[],
) => ({
  _id: collection._id,
  name: collection.name,
  ...(collection.description !== undefined && collection.description !== null
    ? { description: collection.description }
    : {}),
  visibility: collection.visibility,
  lifecycleState: collection.lifecycleState,
  deletedAt: collection.deletedAt ?? null,
  createdAt: collection.createdAt,
  updatedAt: collection.updatedAt,
  ...(memberships ? { memberships: memberships.map(membershipDto) } : {}),
})

export const shapeVisitorCollection = (
  collection: CollectionValue,
  memberships: CollectionMembershipValue[],
) => ({
  _id: collection._id,
  name: collection.name,
  ...(collection.description !== undefined && collection.description !== null
    ? { description: collection.description }
    : {}),
  memberships: memberships.map(membershipDto),
})

const shapeCollectionSummaryBase = (
  collection: CollectionSummaryValue,
  projection: CollectionSummaryProjection,
) => ({
  _id: collection._id,
  name: collection.name,
  ...(collection.description !== undefined && collection.description !== null
    ? { description: collection.description }
    : {}),
  movieCount: projection.movieCount,
  previewMovies: projection.previewMovies,
})

export const shapeOwnerCollectionSummary = (
  collection: CollectionSummaryValue,
  projection: CollectionSummaryProjection,
): OwnerCollectionSummary => ({
  ...shapeCollectionSummaryBase(collection, projection),
  visibility: collection.visibility,
})

export const shapeVisitorCollectionSummary = (
  collection: CollectionSummaryValue,
  projection: CollectionSummaryProjection,
): PublicCollectionSummary => shapeCollectionSummaryBase(collection, projection)

export const shapeOwnerDeletedCollectionSummary = (
  collection: DeletedCollectionValue,
): OwnerDeletedCollectionSummary => ({
  _id: collection._id,
  name: collection.name,
  ...(collection.description !== undefined && collection.description !== null
    ? { description: collection.description }
    : {}),
  deletedAt: collection.deletedAt ?? null,
})

export const buildCollectionSummaryProjection = (
  memberships: PersistedCollectionMembership[],
): CollectionSummaryProjection => ({
  movieCount: memberships.length,
  previewMovies: [...memberships]
    .sort(
      (first, second) =>
        first.position - second.position ||
        first._id.toString().localeCompare(second._id.toString()),
    )
    .slice(0, 3)
    .map(({ tmdbId }) => ({ tmdbId })),
})

const loadCollectionSummaryProjections = async (collectionIds: Types.ObjectId[]) => {
  const membershipsByCollectionId = new Map<string, PersistedCollectionMembership[]>()
  for (const collectionId of collectionIds) {
    membershipsByCollectionId.set(collectionId.toString(), [])
  }
  if (collectionIds.length === 0) return new Map<string, CollectionSummaryProjection>()

  const memberships = (await CollectionMembership.find({
    collectionId: { $in: collectionIds },
  })
    .select('collectionId tmdbId position')
    .lean()) as CollectionSummaryMembership[]

  for (const membership of memberships) {
    membershipsByCollectionId.get(membership.collectionId.toString())?.push(membership)
  }

  return new Map(
    [...membershipsByCollectionId].map(([collectionId, collectionMemberships]) => [
      collectionId,
      buildCollectionSummaryProjection(collectionMemberships),
    ]),
  )
}

const emptyCollectionSummaryProjection = (): CollectionSummaryProjection => ({
  movieCount: 0,
  previewMovies: [],
})

const loadMemberships = (collectionId: Types.ObjectId, session?: ClientSession) => {
  const query = CollectionMembership.find({ collectionId })
    .select('tmdbId position')
    .sort({ position: 1, _id: 1 })
    .lean()
  if (session) query.session(session)
  return query
}

const manageableCollection = async (
  collectionId: string,
  ownerId: Types.ObjectId,
  session: ClientSession,
) => {
  const collection = await Collection.findById(collectionId).session(session).lean()
  if (!collection || !canManageCollection(collection, ownerId)) return undefined

  const lock = await Collection.updateOne(
    { _id: collection._id, ownerId, lifecycleState: 'active' },
    { $set: { updatedAt: new Date() } },
    { session },
  )
  return lock.matchedCount === 1 ? collection : undefined
}

const normalizeMemberships = async (
  collectionId: Types.ObjectId,
  memberships: PersistedCollectionMembership[],
  session: ClientSession,
) => {
  if (memberships.length > 0) {
    await CollectionMembership.bulkWrite(
      memberships.map((membership, position) => ({
        updateOne: {
          filter: { _id: membership._id, collectionId },
          update: { $set: { position } },
        },
      })),
      { session },
    )
  }

  return memberships.map(({ tmdbId }, position) => membershipDto({ tmdbId, position }))
}

const membershipExists = () =>
  new ApiProblem(409, 'COLLECTION_MEMBERSHIP_EXISTS', 'Movie is already in this Collection')

const membershipNotFound = () =>
  new ApiProblem(404, 'COLLECTION_MEMBERSHIP_NOT_FOUND', 'Movie is not in this Collection')

const invalidMembershipOrder = () =>
  new ApiProblem(
    400,
    'COLLECTION_ORDER_INVALID',
    'Order must contain every Collection movie exactly once',
  )

export const createCollection = async (ownerId: Types.ObjectId, input: CreateCollectionInput) => {
  const collection = await Collection.create({
    ownerId,
    name: input.name,
    visibility: input.visibility,
    ...(input.description !== undefined ? { description: input.description } : {}),
  })
  return shapeOwnerCollection(collection.toObject() as CollectionValue, [])
}

export const listActiveCollectionsForOwner = async (ownerId: Types.ObjectId) => {
  const collections = await Collection.find({ ownerId, lifecycleState: 'active' })
    .select('name description visibility')
    .sort({ createdAt: -1, _id: -1 })
    .lean()
  const projections = await loadCollectionSummaryProjections(
    collections.map((collection) => collection._id),
  )

  return collections.map((collection) =>
    shapeOwnerCollectionSummary(
      collection as CollectionSummaryValue,
      projections.get(collection._id.toString()) ?? emptyCollectionSummaryProjection(),
    ),
  )
}

export const listDeletedCollectionsForOwner = async (ownerId: Types.ObjectId) => {
  const collections = await Collection.find({ ownerId, lifecycleState: 'deleted' })
    .select('name description deletedAt')
    .sort({ deletedAt: -1, _id: -1 })
    .lean()

  return collections.map((collection) =>
    shapeOwnerDeletedCollectionSummary(collection as DeletedCollectionValue),
  )
}

export const getOwnerCollectionIdsContainingMovie = async (
  ownerId: Types.ObjectId,
  tmdbId: number,
) => {
  const collections = await Collection.find({ ownerId, lifecycleState: 'active' })
    .select('_id')
    .sort({ createdAt: -1, _id: -1 })
    .lean()
  if (collections.length === 0) return []

  const memberships = await CollectionMembership.find({
    collectionId: { $in: collections.map((collection) => collection._id) },
    tmdbId,
  })
    .select('collectionId')
    .lean()
  const matchingCollectionIds = new Set(
    memberships.map((membership) => membership.collectionId.toString()),
  )

  return collections
    .map((collection) => collection._id.toString())
    .filter((id) => matchingCollectionIds.has(id))
}

export const listPublicCollectionsForOwner = async (ownerId: Types.ObjectId) => {
  const collections = await Collection.find({
    ownerId,
    lifecycleState: 'active',
    visibility: 'public',
  })
    .select('name description visibility')
    .sort({ createdAt: -1, _id: -1 })
    .lean()
  const projections = await loadCollectionSummaryProjections(
    collections.map((collection) => collection._id),
  )

  return collections.map((collection) =>
    shapeVisitorCollectionSummary(
      collection as CollectionSummaryValue,
      projections.get(collection._id.toString()) ?? emptyCollectionSummaryProjection(),
    ),
  )
}

export const getCollectionForViewer = async (
  collectionId: string,
  viewerId?: Types.ObjectId | null,
) => {
  const collection = await Collection.findById(collectionId).lean()
  if (!collection || !canViewCollection(collection, viewerId)) return undefined

  const memberships = canViewCollectionMembership(collection, viewerId)
    ? await loadMemberships(collection._id)
    : []
  const owner = collection.ownerId.toString() === viewerId?.toString()

  return owner
    ? shapeOwnerCollection(collection as CollectionValue, memberships)
    : shapeVisitorCollection(collection as CollectionValue, memberships)
}

export const updateCollectionMetadata = async (
  collectionId: string,
  ownerId: Types.ObjectId,
  input: UpdateCollectionInput,
) => {
  const collection = await Collection.findById(collectionId).lean()
  if (!collection || !canManageCollection(collection, ownerId)) return undefined

  const updated = await Collection.findOneAndUpdate(
    { _id: collection._id, ownerId, lifecycleState: 'active' },
    { $set: input },
    { returnDocument: 'after', runValidators: true },
  ).lean()

  return updated ? shapeOwnerCollection(updated as CollectionValue) : undefined
}

export const recoverablyDeleteCollection = async (
  collectionId: string,
  ownerId: Types.ObjectId,
) => {
  const collection = await Collection.findById(collectionId).lean()
  if (!collection || !canManageCollection(collection, ownerId)) return undefined

  const deleted = await Collection.findOneAndUpdate(
    { _id: collection._id, ownerId, lifecycleState: 'active' },
    { $set: { lifecycleState: 'deleted', deletedAt: new Date() } },
    { returnDocument: 'after', runValidators: true },
  ).lean()

  return deleted ? shapeOwnerCollection(deleted as CollectionValue) : undefined
}

export const restoreCollection = async (collectionId: string, ownerId: Types.ObjectId) => {
  const collection = await Collection.findById(collectionId).lean()
  if (!collection || !canRecoverCollection(collection, ownerId)) return undefined

  const restored = await Collection.findOneAndUpdate(
    { _id: collection._id, ownerId, lifecycleState: 'deleted' },
    { $set: { lifecycleState: 'active', deletedAt: null } },
    { returnDocument: 'after', runValidators: true },
  ).lean()

  return restored ? shapeOwnerCollection(restored as CollectionValue) : undefined
}

export const addCollectionMembership = async (
  collectionId: string,
  ownerId: Types.ObjectId,
  input: AddCollectionMembershipInput,
) => {
  let result: CollectionMembershipValue[] | undefined

  try {
    await connection.transaction(async (session) => {
      const collection = await manageableCollection(collectionId, ownerId, session)
      if (!collection) {
        result = undefined
        return
      }

      const memberships = (await loadMemberships(
        collection._id,
        session,
      )) as PersistedCollectionMembership[]
      if (memberships.some(({ tmdbId }) => tmdbId === input.tmdbId)) throw membershipExists()

      const created = await CollectionMembership.create(
        [{ collectionId: collection._id, tmdbId: input.tmdbId, position: memberships.length }],
        { session },
      )
      const membership = created[0]
      if (!membership) throw new Error('Collection membership creation failed')

      result = await normalizeMemberships(
        collection._id,
        [...memberships, membership.toObject() as PersistedCollectionMembership],
        session,
      )
    })
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      throw membershipExists()
    }
    throw error
  }

  return result
}

export const removeCollectionMembership = async (
  collectionId: string,
  ownerId: Types.ObjectId,
  tmdbId: number,
) => {
  let result: CollectionMembershipValue[] | undefined

  await connection.transaction(async (session) => {
    const collection = await manageableCollection(collectionId, ownerId, session)
    if (!collection) {
      result = undefined
      return
    }

    const memberships = (await loadMemberships(
      collection._id,
      session,
    )) as PersistedCollectionMembership[]
    const membership = memberships.find((candidate) => candidate.tmdbId === tmdbId)
    if (!membership) throw membershipNotFound()

    await CollectionMembership.deleteOne(
      { _id: membership._id, collectionId: collection._id },
      { session },
    )
    result = await normalizeMemberships(
      collection._id,
      memberships.filter((candidate) => candidate._id.toString() !== membership._id.toString()),
      session,
    )
  })

  return result
}

export const reorderCollectionMemberships = async (
  collectionId: string,
  ownerId: Types.ObjectId,
  input: ReorderCollectionMembershipsInput,
) => {
  let result: CollectionMembershipValue[] | undefined

  await connection.transaction(async (session) => {
    const collection = await manageableCollection(collectionId, ownerId, session)
    if (!collection) {
      result = undefined
      return
    }

    const memberships = (await loadMemberships(
      collection._id,
      session,
    )) as PersistedCollectionMembership[]
    const membershipsByTmdbId = new Map(
      memberships.map((membership) => [membership.tmdbId, membership]),
    )
    if (
      input.tmdbIds.length !== memberships.length ||
      new Set(input.tmdbIds).size !== input.tmdbIds.length ||
      input.tmdbIds.some((tmdbId) => !membershipsByTmdbId.has(tmdbId))
    ) {
      throw invalidMembershipOrder()
    }

    result = await normalizeMemberships(
      collection._id,
      input.tmdbIds.map((tmdbId) => membershipsByTmdbId.get(tmdbId)!),
      session,
    )
  })

  return result
}
