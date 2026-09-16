import { io } from 'socket.io-client'
import { refreshRealtimeAccessToken } from './api'
import { createRealtimeSession, type RealtimeSocket } from './realtimeSession'

export type { RealtimeEvents } from './realtimeSession'

const session = createRealtimeSession(
  (token) =>
    io(import.meta.env.VITE_API_BASE_URL, {
      autoConnect: false,
      auth: { token },
    }) as unknown as RealtimeSocket,
  refreshRealtimeAccessToken,
)

export const connectRealtime = session.connect
export const disconnectRealtime = session.disconnect
export const onRealtime = session.on
export const onRealtimeConnect = session.onConnect
export const subscribeDiscussion = session.subscribeDiscussion
export const unsubscribeDiscussion = session.unsubscribeDiscussion
