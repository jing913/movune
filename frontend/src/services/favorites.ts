import api from '@/services/api'

export interface Favorite {
  _id: string
  userId: string
  tmdbId: number
  genreIds?: number[]
  createdAt: string
  updatedAt: string
}

export interface FavoritesResponse {
  favorites: Favorite[]
}

export type FavoritesVisibility = 'private' | 'public'

interface FavoritesVisibilityResponse {
  visibility: FavoritesVisibility
}

export async function getFavorites(accessToken: string) {
  const favoritesResponse = await api.get<FavoritesResponse>('/api/favorites', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  return favoritesResponse.data.favorites
}

export async function getFavoritesVisibility(accessToken: string) {
  const response = await api.get<FavoritesVisibilityResponse>('/api/favorites/visibility', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return response.data.visibility
}

export async function updateFavoritesVisibility(
  visibility: FavoritesVisibility,
  accessToken: string,
) {
  const response = await api.patch<FavoritesVisibilityResponse>(
    '/api/favorites/visibility',
    { visibility },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  return response.data.visibility
}

interface CreateFavoriteResponse {
  favorite: Favorite
}

export interface CreateFavoriteInput {
  tmdbId: number
  genreIds: number[]
}

export async function createFavorite(input: CreateFavoriteInput, accessToken: string) {
  const favoriteResponse = await api.post<CreateFavoriteResponse>('/api/favorites', input, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  return favoriteResponse.data.favorite
}

export async function deleteFavorite(tmdbId: number, accessToken: string) {
  await api.delete(`/api/favorites/${tmdbId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
