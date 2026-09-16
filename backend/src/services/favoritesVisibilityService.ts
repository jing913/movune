import type { HydratedDocument } from 'mongoose'
import type { IUser } from '../models/userModel.js'
import {
  FAVORITES_VISIBILITIES,
  resolveFavoritesVisibility,
  type FavoritesVisibility,
} from '../utils/favoriteVisibility.js'

type FavoritesVisibilityRecord = Pick<IUser, 'favoritesPublic'>

export const isFavoritesVisibility = (value: unknown): value is FavoritesVisibility =>
  typeof value === 'string' && FAVORITES_VISIBILITIES.includes(value as FavoritesVisibility)

export const getFavoritesVisibility = (user: FavoritesVisibilityRecord): FavoritesVisibility =>
  resolveFavoritesVisibility(user.favoritesPublic)

export const setFavoritesVisibility = async (
  user: HydratedDocument<IUser>,
  visibility: FavoritesVisibility,
): Promise<FavoritesVisibility> => {
  user.favoritesPublic = visibility === 'public'
  await user.save()
  return getFavoritesVisibility(user)
}
