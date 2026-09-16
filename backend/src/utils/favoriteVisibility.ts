export const FAVORITES_VISIBILITIES = ['private', 'public'] as const

export type FavoritesVisibility = (typeof FAVORITES_VISIBILITIES)[number]

export const resolveFavoritesVisibility = (favoritesPublic: unknown): FavoritesVisibility =>
  favoritesPublic === true ? 'public' : 'private'

export const PUBLIC_FAVORITES_PERSISTENCE_MATCH = { favoritesPublic: true } as const
