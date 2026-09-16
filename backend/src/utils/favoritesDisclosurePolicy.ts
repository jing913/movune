import type { FavoritesVisibility } from './favoriteVisibility.js'

type IdValue = {
  toString(): string
}

export const canViewFavorites = (
  ownerId: IdValue,
  viewerId: IdValue | null | undefined,
  visibility: FavoritesVisibility,
) => {
  const isOwner =
    viewerId !== null && viewerId !== undefined && ownerId.toString() === viewerId.toString()

  return isOwner || visibility === 'public'
}

export const loadVisibleFavorites = async <FavoriteValue>(
  ownerId: IdValue,
  viewerId: IdValue | null | undefined,
  visibility: FavoritesVisibility,
  loadFavorites: () => Promise<FavoriteValue[]>,
) => {
  if (!canViewFavorites(ownerId, viewerId, visibility)) {
    return undefined
  }

  return loadFavorites()
}
