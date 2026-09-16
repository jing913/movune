import type { MessageDto } from './messaging'
import { shallowRef, watch, type Ref } from 'vue'

export type RealtimeEvents = {
  'message.created': { message: MessageDto }
  'direct.updated': { conversationId: string }
  'relationship.updated': { userId: string }
  'notification.created': { notificationId: string }
  'read.updated':
    | { resource: 'direct'; id: string }
    | { resource: 'discussion'; id: string }
    | { resource: 'notification'; id: string }
    | { resource: 'notifications' }
  'discussion.membership.updated': { roomId: string; membership: unknown }
}

export type RealtimeSocket = {
  connected: boolean
  auth: Record<string, unknown>
  connect(): void
  disconnect(): void
  on(event: string, listener: (payload: never) => void): void
  off(event: string, listener: (payload: never) => void): void
  emit(event: string, payload: unknown): void
}

type Listener<K extends keyof RealtimeEvents> = (payload: RealtimeEvents[K]) => void

type RealtimeIdentitySession = {
  connect(token: string, userId: string): unknown
  disconnect(): void
}

export function createAuthCredentialTransitionBoundary(commitCredential: (token: string) => void) {
  let transitionVersion = 0
  let transitionPending = false

  const beginTransition = () => {
    const version = ++transitionVersion
    transitionPending = true
    let completed = false
    return () => {
      if (completed) return
      completed = true
      if (version === transitionVersion) {
        transitionPending = false
        transitionVersion += 1
      }
    }
  }

  const runCredentialOperation = async (operation: () => Promise<string>) => {
    const version = transitionVersion
    const token = await operation()
    if (!transitionPending && version === transitionVersion) commitCredential(token)
    return token
  }

  return { beginTransition, runCredentialOperation }
}

type LogoutIdentityState = {
  suspendRealtime(): void
  clear(): void
}

export async function logoutAuthenticatedIdentity(
  beginTransition: () => () => void,
  identity: LogoutIdentityState,
  requestLogout: () => Promise<unknown>,
) {
  const completeTransition = beginTransition()
  identity.suspendRealtime()
  try {
    await requestLogout()
  } finally {
    identity.clear()
    completeTransition()
  }
}

export type VerifiedRealtimeIdentity = {
  token: string
  userId: string
}

export function bindRealtimeIdentity(
  verifiedIdentity: Ref<VerifiedRealtimeIdentity | null>,
  session: RealtimeIdentitySession,
) {
  return watch(
    verifiedIdentity,
    (identity) => {
      if (identity) session.connect(identity.token, identity.userId)
      else session.disconnect()
    },
    { immediate: true, flush: 'sync' },
  )
}

export function createAuthenticatedIdentityState<User extends { _id: string }>(
  session: RealtimeIdentitySession,
) {
  const currentUser = shallowRef<User | null>(null)
  const accessToken = shallowRef<string | null>(null)
  const verifiedRealtimeIdentity = shallowRef<VerifiedRealtimeIdentity | null>(null)
  let identityTransitionVersion = 0
  let pendingIdentityVerifications = 0
  bindRealtimeIdentity(verifiedRealtimeIdentity, session)

  const applyCommit = (token: string, user: User) => {
    if (verifiedRealtimeIdentity.value && verifiedRealtimeIdentity.value.userId !== user._id)
      verifiedRealtimeIdentity.value = null
    currentUser.value = user
    accessToken.value = token
    verifiedRealtimeIdentity.value = { token, userId: user._id }
  }

  const clearState = () => {
    verifiedRealtimeIdentity.value = null
    currentUser.value = null
    accessToken.value = null
  }

  const commit = (token: string, user: User) => {
    identityTransitionVersion += 1
    applyCommit(token, user)
  }

  const clear = () => {
    identityTransitionVersion += 1
    clearState()
  }

  const suspendRealtime = () => {
    identityTransitionVersion += 1
    verifiedRealtimeIdentity.value = null
  }

  const setVerifiedAccessToken = (token: string | null) => {
    if (!token) {
      clear()
      return
    }
    if (pendingIdentityVerifications || !currentUser.value) return
    accessToken.value = token
    verifiedRealtimeIdentity.value = { token, userId: currentUser.value._id }
  }

  const login = async (
    resolveToken: () => Promise<string>,
    resolveUser: (token: string) => Promise<User>,
  ) => {
    const transitionVersion = ++identityTransitionVersion
    const previousIdentity = verifiedRealtimeIdentity.value
    let pendingTokenObtained = false
    pendingIdentityVerifications += 1
    verifiedRealtimeIdentity.value = null
    try {
      const pendingToken = await resolveToken()
      pendingTokenObtained = true
      const verifiedUser = await resolveUser(pendingToken)
      if (transitionVersion !== identityTransitionVersion)
        throw new Error('Authentication transition superseded.')
      applyCommit(pendingToken, verifiedUser)
    } catch (error) {
      if (transitionVersion !== identityTransitionVersion) throw error
      if (
        !pendingTokenObtained &&
        previousIdentity &&
        currentUser.value?._id === previousIdentity.userId &&
        accessToken.value === previousIdentity.token
      )
        verifiedRealtimeIdentity.value = previousIdentity
      else if (pendingTokenObtained) clearState()
      throw error
    } finally {
      pendingIdentityVerifications -= 1
    }
  }

  return {
    currentUser,
    accessToken,
    commit,
    clear,
    suspendRealtime,
    setVerifiedAccessToken,
    login,
  }
}

export function createRealtimeSession(
  createSocket: (token: string) => RealtimeSocket,
  refreshToken: () => Promise<string>,
) {
  let socket: RealtimeSocket | null = null
  let identity: string | null = null
  const listeners = new Map<keyof RealtimeEvents, Set<(payload: never) => void>>()
  const connectListeners = new Set<() => void>()
  const attachedEvents = new WeakMap<RealtimeSocket, Set<string>>()

  const attachEventBridge = (target: RealtimeSocket, event: keyof RealtimeEvents) => {
    const attached = attachedEvents.get(target) ?? new Set<string>()
    if (attached.has(event)) return
    attached.add(event)
    attachedEvents.set(target, attached)
    target.on(event, ((payload: never) => {
      if (socket !== target) return
      for (const listener of listeners.get(event) ?? []) listener(payload)
    }) as (payload: never) => void)
  }

  const attachConnectBridge = (target: RealtimeSocket) => {
    const attached = attachedEvents.get(target) ?? new Set<string>()
    if (attached.has('connect')) return
    attached.add('connect')
    attachedEvents.set(target, attached)
    target.on('connect', (() => {
      if (socket !== target) return
      for (const listener of connectListeners) listener()
    }) as (payload: never) => void)
  }

  const attachListeners = (target: RealtimeSocket) => {
    for (const event of listeners.keys()) attachEventBridge(target, event)
    if (connectListeners.size) attachConnectBridge(target)
  }

  const buildSocket = (token: string) => {
    const target = createSocket(token)
    attachListeners(target)
    target.on('connect_error', (async (error: Error) => {
      if (error.message !== 'AUTHENTICATION_REQUIRED' || socket !== target) return
      try {
        const refreshedToken = await refreshToken()
        if (socket !== target) return
        target.auth = { token: refreshedToken }
        target.connect()
      } catch {
        if (socket === target) target.disconnect()
      }
    }) as (payload: never) => void)
    return target
  }

  return {
    connect(token: string, userId: string) {
      if (socket && identity !== userId) {
        const previousSocket = socket
        socket = null
        previousSocket.disconnect()
      }
      identity = userId
      if (!socket) socket = buildSocket(token)
      socket.auth = { token }
      if (!socket.connected) socket.connect()
      return socket
    },
    disconnect() {
      const previousSocket = socket
      socket = null
      identity = null
      previousSocket?.disconnect()
    },
    on<K extends keyof RealtimeEvents>(event: K, listener: Listener<K>) {
      const bridge = listener as (payload: never) => void
      const eventListeners = listeners.get(event) ?? new Set<(payload: never) => void>()
      eventListeners.add(bridge)
      listeners.set(event, eventListeners)
      if (socket) attachEventBridge(socket, event)
      return () => {
        eventListeners.delete(bridge)
      }
    },
    onConnect(listener: () => void) {
      connectListeners.add(listener)
      if (socket) attachConnectBridge(socket)
      return () => {
        connectListeners.delete(listener)
      }
    },
    subscribeDiscussion(roomId: string) {
      socket?.emit('discussion.subscribe', { roomId })
    },
    unsubscribeDiscussion(roomId: string) {
      socket?.emit('discussion.unsubscribe', { roomId })
    },
  }
}
