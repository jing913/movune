import api from '@/services/api'
import type { FollowerPerson, FollowingPerson } from '@/services/users'

export interface FollowSummary {
  followerCount: number
  followingCount: number
  isFollowing: boolean
  isSelf: boolean
}

export interface FollowingRecord {
  _id: string
  followingId: string
  createdAt: string
}

export async function getFollowSummary(userId: string, accessToken: string) {
  const response = await api.get<FollowSummary>(`/api/follows/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  return response.data
}

export async function followUser(userId: string, accessToken: string) {
  await api.post(`/api/follows/${encodeURIComponent(userId)}`, undefined, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

export async function unfollowUser(userId: string, accessToken: string) {
  await api.delete(`/api/follows/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

export async function getMyFollowing(accessToken: string) {
  const response = await api.get<{ follows: FollowingRecord[] }>('/api/follows', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  return response.data.follows
}

export async function getMyFollowingUsers(accessToken: string) {
  const response = await api.get<{ users: FollowingPerson[] }>('/api/follows/me/following', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return response.data.users
}

export async function getMyFollowerUsers(accessToken: string) {
  const response = await api.get<{ users: FollowerPerson[] }>('/api/follows/me/followers', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return response.data.users
}
