import api from '@/services/api'
import type { PublicCollectionSummary } from '@/services/collections'
import type { Favorite } from '@/services/favorites'

export interface PublicUser {
  _id: string
  account: string
  displayName: string
  avatar?: string
  bio?: string
}

export interface User extends PublicUser {
  capabilities: {
    manageAnnouncements: boolean
  }
}

export interface PeopleIdentity extends PublicUser {
  isFollowing: boolean
  followerCount: number
  followingCount: number
}

export type UserSummary = PeopleIdentity

export interface MovieDetailPerson extends PeopleIdentity {
  alsoFavorited: true
}

export interface FollowingPerson extends PeopleIdentity {
  sharedDnaGenres: SharedDnaGenre[]
}

export type FollowerPerson = PeopleIdentity

export interface UsersResponse {
  users: UserSummary[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface MoviePeopleResponse {
  users: MovieDetailPerson[]
  pagination: UsersResponse['pagination']
}

export interface SharedDnaGenre {
  genreId: number
  sharedGenreStrength: number
}

export interface EncounterCandidate extends PublicUser {
  isFollowing: boolean
  followerCount: number
  followingCount: number
  sharedDnaGenres: SharedDnaGenre[]
  revealableSharedFavoriteTmdbIds: number[]
}

interface EncounterCandidatesResponse {
  status: 'eligible' | 'insufficient_signal'
  candidates: EncounterCandidate[]
}

export interface FormalRecommendationItem {
  _id: string
  account: string
  displayName: string
  avatar?: string
  bio?: string
  isFollowing: boolean
  followerCount: number
  followingCount: number
  sharedDnaGenres: SharedDnaGenre[]
  revealableSharedFavoriteTmdbIds: number[]
}

export interface FormalRecommendationsResponse {
  status: 'eligible' | 'insufficient_signal'
  items: FormalRecommendationItem[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface MovieSpaceResponse {
  user: PublicUser
  favorites?: Favorite[]
  collections: PublicCollectionSummary[]
}

export interface MovieDnaGenre {
  genreId: number
  count: number
  percentage: number
}

export interface MovieDna {
  totalFavorites: number
  analyzedFavorites: number
  genres: MovieDnaGenre[]
}

export interface MovieDnaResponse {
  movieDnaVisibility: 'available' | 'private'
  movieDna?: MovieDna
}

export interface DnaMatch {
  status: 'eligible' | 'insufficient_signal'
  sharedDnaGenres: Array<{
    genreId: number
    sharedGenreStrength: number
  }>
  revealableSharedFavoriteTmdbIds: number[]
}

interface DnaMatchResponse {
  dnaMatch: DnaMatch
}

interface UserResponse {
  user: User
}

export async function updateProfile(
  profile: { displayName: string; bio: string },
  accessToken: string,
) {
  const response = await api.patch<UserResponse>('/api/users/me/profile', profile, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return response.data.user
}

export async function getMovieSpace(userId: string, accessToken: string) {
  const response = await api.get<MovieSpaceResponse>(
    `/api/users/${encodeURIComponent(userId)}/movie-space`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  return response.data
}

export async function getMovieDna(userId: string, accessToken: string) {
  const response = await api.get<MovieDnaResponse>(
    `/api/users/${encodeURIComponent(userId)}/movie-dna`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  return response.data
}

export async function getUsers(
  input: {
    search?: string
    page?: number
    limit?: number
    following?: 'all' | 'following' | 'not-following'
    genreIds?: number[]
    sharedFavorites?: boolean
  },
  accessToken: string,
) {
  const response = await api.get<UsersResponse>('/api/users', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: {
      ...input,
      genreIds: input.genreIds?.join(',') || undefined,
    },
  })

  return response.data
}

export async function getFormalRecommendations(
  input: { page?: number; limit?: number },
  accessToken: string,
) {
  const response = await api.get<FormalRecommendationsResponse>('/api/users/recommendations', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: input,
  })

  return response.data
}

export async function getMoviePeople(
  tmdbId: number,
  input: { page?: number; limit?: number },
  accessToken: string,
) {
  const response = await api.get<MoviePeopleResponse>(`/api/users/movie/${tmdbId}/people`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: input,
  })

  return response.data
}

export async function getEncounterCandidates(
  sessionExcludedIds: string[],
  cooldownIds: string[],
  accessToken: string,
) {
  const response = await api.post<EncounterCandidatesResponse>(
    '/api/users/encounter',
    { sessionExcludedIds, cooldownIds },
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  return response.data
}

export async function getDnaMatch(userId: string, accessToken: string) {
  const response = await api.get<DnaMatchResponse>(
    `/api/users/${encodeURIComponent(userId)}/dna-match`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  return response.data.dnaMatch
}
