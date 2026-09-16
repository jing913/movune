type IdValue = {
  toString(): string
}

type CollectionAccessState = {
  ownerId: IdValue
  visibility: 'private' | 'public'
  lifecycleState: 'active' | 'deleted'
}

const isOwner = (collection: CollectionAccessState, viewerId?: IdValue | null) =>
  viewerId !== undefined &&
  viewerId !== null &&
  collection.ownerId.toString() === viewerId.toString()

export const canViewCollection = (collection: CollectionAccessState, viewerId?: IdValue | null) =>
  collection.lifecycleState === 'active' &&
  (isOwner(collection, viewerId) || collection.visibility === 'public')

export const canManageCollection = (collection: CollectionAccessState, viewerId?: IdValue | null) =>
  collection.lifecycleState === 'active' && isOwner(collection, viewerId)

export const canViewCollectionMembership = (
  collection: CollectionAccessState,
  viewerId?: IdValue | null,
) => canViewCollection(collection, viewerId)

export const canRecoverCollection = (
  collection: CollectionAccessState,
  viewerId?: IdValue | null,
) => collection.lifecycleState === 'deleted' && isOwner(collection, viewerId)
