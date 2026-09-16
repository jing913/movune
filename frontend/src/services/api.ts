import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { createAuthCredentialTransitionBoundary } from './realtimeSession'

type AuthSessionBridge = {
  getAccessToken: () => string | null
  setAccessToken: (accessToken: string | null) => void
}

type RetriableRequestConfig = InternalAxiosRequestConfig & {
  _movuneAuthRetry?: boolean
}

const baseURL = import.meta.env.VITE_API_BASE_URL

const api = axios.create({
  baseURL,
  withCredentials: true,
})

const refreshClient = axios.create({ baseURL, withCredentials: true })
let authSessionBridge: AuthSessionBridge | null = null
let refreshPromise: Promise<string> | null = null
const authTransitionBoundary = createAuthCredentialTransitionBoundary((token) =>
  authSessionBridge?.setAccessToken(token),
)

export function configureApiAuth(bridge: AuthSessionBridge) {
  authSessionBridge = bridge
}

export const beginAuthIdentityTransition = authTransitionBoundary.beginTransition

export async function withUncommittedAuthIdentity<T>(operation: () => Promise<T>) {
  const completeTransition = beginAuthIdentityTransition()
  try {
    return await operation()
  } finally {
    completeTransition()
  }
}

const requestRefreshedAccessToken = async () => {
  refreshPromise ??= refreshClient
    .post<{ accessToken: string }>('/api/auth/refresh')
    .then((response) => response.data.accessToken)
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}

export async function refreshAccessToken() {
  return authTransitionBoundary.runCredentialOperation(requestRefreshedAccessToken)
}

export const refreshRealtimeAccessToken = requestRefreshedAccessToken

export const getAuthenticatedUserWithUncommittedToken = <User>(accessToken: string) =>
  refreshClient
    .get<{ user: User }>('/api/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .then((response) => response.data.user)

api.interceptors.request.use((config) => {
  const accessToken = authSessionBridge?.getAccessToken()
  if (accessToken && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableRequestConfig | undefined
    const isUnauthorized = error.response?.status === 401
    const isAuthLifecycleRequest = config?.url?.startsWith('/api/auth/') === true

    if (!config || !isUnauthorized || isAuthLifecycleRequest || config._movuneAuthRetry) {
      throw error
    }

    config._movuneAuthRetry = true

    try {
      const accessToken = await refreshAccessToken()
      config.headers.Authorization = `Bearer ${accessToken}`
      return api.request(config)
    } catch (refreshError) {
      const attemptedAccessToken = config.headers.Authorization?.toString().replace(/^Bearer /, '')
      if (attemptedAccessToken === authSessionBridge?.getAccessToken())
        authSessionBridge?.setAccessToken(null)
      throw refreshError
    }
  },
)

export default api
