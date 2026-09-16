import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import api, {
  beginAuthIdentityTransition,
  configureApiAuth,
  getAuthenticatedUserWithUncommittedToken,
  withUncommittedAuthIdentity,
} from '@/services/api'
import { updateProfile as updateProfileRequest, type User } from '@/services/users'
import { connectRealtime, disconnectRealtime } from '@/services/realtime'
import {
  createAuthenticatedIdentityState,
  logoutAuthenticatedIdentity,
} from '@/services/realtimeSession'

interface ApiMessageResponse {
  message: string
}

export const useUserStore = defineStore('user', () => {
  const authIdentity = createAuthenticatedIdentityState<User>({
    connect: connectRealtime,
    disconnect: disconnectRealtime,
  })
  const { currentUser, accessToken } = authIdentity
  // 登入狀態確認
  const isAuthLoading = ref(true)
  let restoreAuthPromise: Promise<void> | null = null

  configureApiAuth({
    getAccessToken: () => accessToken.value,
    setAccessToken: authIdentity.setVerifiedAccessToken,
  })

  // 登入狀態
  const isLoggedIn = computed(() => {
    return Boolean(currentUser.value)
  })

  // 設定使用者
  function setUser(user: User) {
    currentUser.value = user
  }

  // 登出
  async function logout() {
    await logoutAuthenticatedIdentity(beginAuthIdentityTransition, authIdentity, async () =>
      api.post('/api/auth/logout'),
    )
  }

  async function restoreAuth() {
    if (!isAuthLoading.value) return
    if (restoreAuthPromise) return restoreAuthPromise

    restoreAuthPromise = (async () => {
      try {
        await withUncommittedAuthIdentity(() =>
          authIdentity.login(
            async () => (await api.post('/api/auth/refresh')).data.accessToken,
            getAuthenticatedUserWithUncommittedToken<User>,
          ),
        )
      } catch {
        authIdentity.clear()
      } finally {
        isAuthLoading.value = false
        restoreAuthPromise = null
      }
    })()

    return restoreAuthPromise
  }

  async function login(email: string, password: string, rememberMe = false) {
    await withUncommittedAuthIdentity(() =>
      authIdentity.login(
        async () =>
          (await api.post('/api/auth/login', { email, password, rememberMe })).data.accessToken,
        getAuthenticatedUserWithUncommittedToken<User>,
      ),
    )
  }

  async function register(account: string, email: string, password: string) {
    await api.post('/api/auth/register', {
      account,
      email,
      password,
    })
  }

  async function forgotPassword(email: string) {
    const response = await api.post<ApiMessageResponse>('/api/auth/forgot-password', { email })
    return response.data.message
  }

  async function resetPassword(token: string, password: string, passwordConfirmation: string) {
    const response = await api.post<ApiMessageResponse>('/api/auth/reset-password', {
      token,
      password,
      passwordConfirmation,
    })
    return response.data.message
  }

  async function updateProfile(profile: { displayName: string; bio: string }) {
    if (!accessToken.value) throw new Error('Access token is required')
    const user = await updateProfileRequest(profile, accessToken.value)
    currentUser.value = user
    return user
  }

  return {
    currentUser,
    isLoggedIn,
    setUser,
    logout,
    isAuthLoading,
    restoreAuth,
    login,
    register,
    forgotPassword,
    resetPassword,
    updateProfile,
    accessToken,
  }
})
