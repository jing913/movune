import axios from 'axios'
import api from '@/services/api'

export type CollectionVisibility = 'private' | 'public'

export interface CollectionMembership {
  tmdbId: number
  position: number
}

export interface CollectionPreviewMovie {
  tmdbId: number
}

export interface PublicCollectionSummary {
  _id: string
  name: string
  description?: string
  movieCount: number
  previewMovies: CollectionPreviewMovie[]
}

export interface OwnerCollectionSummary extends PublicCollectionSummary {
  visibility: CollectionVisibility
}

export interface DeletedCollectionSummary {
  _id: string
  name: string
  description?: string
  deletedAt: string | null
}

export interface OwnerCollection {
  _id: string
  name: string
  description?: string
  visibility: CollectionVisibility
  lifecycleState: 'active' | 'deleted'
  deletedAt: string | null
  createdAt: string
  updatedAt: string
  memberships?: CollectionMembership[]
}

export interface VisitorCollection {
  _id: string
  name: string
  description?: string
  memberships: CollectionMembership[]
}

export type CollectionDetail = OwnerCollection | VisitorCollection

export interface CollectionMetadataInput {
  name: string
  description?: string
  visibility: CollectionVisibility
}

export interface MovieCollectionMembershipLookup {
  collectionIds: string[]
}

export function isOwnerCollection(collection: CollectionDetail): collection is OwnerCollection {
  return 'visibility' in collection
}

export function getCollectionErrorMessage(error: unknown, fallback: string) {
  if (!axios.isAxiosError(error)) return fallback
  const data = error.response?.data
  if (typeof data !== 'object' || data === null) return fallback
  if ('message' in data && typeof data.message === 'string') return data.message
  if ('error' in data && typeof data.error === 'object' && data.error !== null) {
    const problem = data.error
    if ('message' in problem && typeof problem.message === 'string') return problem.message
  }
  return fallback
}

export function isExistingMembershipError(error: unknown) {
  if (!axios.isAxiosError(error)) return false
  const data = error.response?.data
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'object' &&
    data.error !== null &&
    'code' in data.error &&
    data.error.code === 'COLLECTION_MEMBERSHIP_EXISTS'
  )
}

export async function getCollections() {
  const response = await api.get<{ collections: OwnerCollectionSummary[] }>('/api/collections')
  return response.data.collections
}

export async function getDeletedCollections() {
  const response = await api.get<{ collections: DeletedCollectionSummary[] }>(
    '/api/collections/deleted',
  )
  return response.data.collections
}

export async function getMovieCollectionMemberships(tmdbId: number) {
  const response = await api.get<MovieCollectionMembershipLookup>('/api/collections/memberships', {
    params: { tmdbId },
  })
  return response.data
}

export async function createCollection(input: CollectionMetadataInput) {
  const response = await api.post<{ collection: OwnerCollection }>('/api/collections', input)
  return response.data.collection
}

export async function getCollection(collectionId: string) {
  const response = await api.get<{ collection: CollectionDetail }>(
    `/api/collections/${collectionId}`,
  )
  return response.data.collection
}

export async function updateCollection(collectionId: string, input: CollectionMetadataInput) {
  const response = await api.patch<{ collection: OwnerCollection }>(
    `/api/collections/${collectionId}`,
    input,
  )
  return response.data.collection
}

export async function deleteCollection(collectionId: string) {
  const response = await api.delete<{ collection: OwnerCollection }>(
    `/api/collections/${collectionId}`,
  )
  return response.data.collection
}

export async function restoreCollection(collectionId: string) {
  const response = await api.post<{ collection: OwnerCollection }>(
    `/api/collections/${collectionId}/restore`,
  )
  return response.data.collection
}

export async function addCollectionMembership(collectionId: string, tmdbId: number) {
  const response = await api.post<{ memberships: CollectionMembership[] }>(
    `/api/collections/${collectionId}/memberships`,
    { tmdbId },
  )
  return response.data.memberships
}

export async function removeCollectionMembership(collectionId: string, tmdbId: number) {
  const response = await api.delete<{ memberships: CollectionMembership[] }>(
    `/api/collections/${collectionId}/memberships/${tmdbId}`,
  )
  return response.data.memberships
}

export async function reorderCollectionMemberships(collectionId: string, tmdbIds: number[]) {
  const response = await api.put<{ memberships: CollectionMembership[] }>(
    `/api/collections/${collectionId}/memberships/order`,
    { tmdbIds },
  )
  return response.data.memberships
}
