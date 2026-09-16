import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isObjectIdOrHexString } from 'mongoose'
import {
  addCollectionMembership,
  createCollection,
  getCollectionForViewer,
  getOwnerCollectionIdsContainingMovie,
  listActiveCollectionsForOwner,
  listDeletedCollectionsForOwner,
  recoverablyDeleteCollection,
  removeCollectionMembership,
  reorderCollectionMemberships,
  restoreCollection,
  updateCollectionMetadata,
} from '../services/collectionService.js'
import {
  parseAddCollectionMembership,
  parseCollectionMembershipTmdbId,
  parseCreateCollection,
  parseReorderCollectionMemberships,
  parseUpdateCollection,
} from '../utils/collectionValidation.js'

type CollectionParams = {
  collectionId: string
}

type CollectionMembershipParams = CollectionParams & {
  tmdbId: string
}

const requireUser = (req: Request) => {
  if (!req.user) throw new Error('Authentication middleware invariant failed')
  return req.user
}

const collectionId = (req: Request<CollectionParams>, res: Response) => {
  if (!isObjectIdOrHexString(req.params.collectionId)) {
    res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid Collection id' })
    return undefined
  }
  return req.params.collectionId
}

const handler =
  <RequestType extends Request>(operation: (req: RequestType, res: Response) => Promise<unknown>) =>
  async (req: RequestType, res: Response, next: NextFunction) => {
    try {
      await operation(req, res)
    } catch (error) {
      next(error)
    }
  }

const sendCollectionNotFound = (res: Response) =>
  res.status(StatusCodes.NOT_FOUND).json({ message: 'Collection not found' })

export const createCollectionController = handler(async (req, res) => {
  const input = await parseCreateCollection(req.body)
  const collection = await createCollection(requireUser(req)._id, input)
  res.status(StatusCodes.CREATED).json({ collection })
})

export const listMyCollectionsController = handler(async (req, res) => {
  const collections = await listActiveCollectionsForOwner(requireUser(req)._id)
  res.status(StatusCodes.OK).json({ collections })
})

export const listMyDeletedCollectionsController = handler(async (req, res) => {
  const collections = await listDeletedCollectionsForOwner(requireUser(req)._id)
  res.status(StatusCodes.OK).json({ collections })
})

export const getMyCollectionMembershipsForMovieController = handler(async (req, res) => {
  const tmdbId = await parseCollectionMembershipTmdbId(req.query.tmdbId)
  const collectionIds = await getOwnerCollectionIdsContainingMovie(requireUser(req)._id, tmdbId)
  res.status(StatusCodes.OK).json({ collectionIds })
})

export const getCollectionController = handler<Request<CollectionParams>>(async (req, res) => {
  const id = collectionId(req, res)
  if (!id) return

  const collection = await getCollectionForViewer(id, req.user?._id)
  if (!collection) {
    sendCollectionNotFound(res)
    return
  }

  res.status(StatusCodes.OK).json({ collection })
})

export const updateCollectionController = handler<Request<CollectionParams>>(async (req, res) => {
  const id = collectionId(req, res)
  if (!id) return

  const input = await parseUpdateCollection(req.body)
  const collection = await updateCollectionMetadata(id, requireUser(req)._id, input)
  if (!collection) {
    sendCollectionNotFound(res)
    return
  }

  res.status(StatusCodes.OK).json({ collection })
})

export const deleteCollectionController = handler<Request<CollectionParams>>(async (req, res) => {
  const id = collectionId(req, res)
  if (!id) return

  const collection = await recoverablyDeleteCollection(id, requireUser(req)._id)
  if (!collection) {
    sendCollectionNotFound(res)
    return
  }

  res.status(StatusCodes.OK).json({ collection })
})

export const restoreCollectionController = handler<Request<CollectionParams>>(async (req, res) => {
  const id = collectionId(req, res)
  if (!id) return

  const collection = await restoreCollection(id, requireUser(req)._id)
  if (!collection) {
    sendCollectionNotFound(res)
    return
  }

  res.status(StatusCodes.OK).json({ collection })
})

export const addCollectionMembershipController = handler<Request<CollectionParams>>(
  async (req, res) => {
    const id = collectionId(req, res)
    if (!id) return

    const input = await parseAddCollectionMembership(req.body)
    const memberships = await addCollectionMembership(id, requireUser(req)._id, input)
    if (!memberships) {
      sendCollectionNotFound(res)
      return
    }

    res.status(StatusCodes.CREATED).json({ memberships })
  },
)

export const removeCollectionMembershipController = handler<Request<CollectionMembershipParams>>(
  async (req, res) => {
    const id = collectionId(req, res)
    if (!id) return

    const tmdbId = await parseCollectionMembershipTmdbId(req.params.tmdbId)
    const memberships = await removeCollectionMembership(id, requireUser(req)._id, tmdbId)
    if (!memberships) {
      sendCollectionNotFound(res)
      return
    }

    res.status(StatusCodes.OK).json({ memberships })
  },
)

export const reorderCollectionMembershipsController = handler<Request<CollectionParams>>(
  async (req, res) => {
    const id = collectionId(req, res)
    if (!id) return

    const input = await parseReorderCollectionMemberships(req.body)
    const memberships = await reorderCollectionMemberships(id, requireUser(req)._id, input)
    if (!memberships) {
      sendCollectionNotFound(res)
      return
    }

    res.status(StatusCodes.OK).json({ memberships })
  },
)
