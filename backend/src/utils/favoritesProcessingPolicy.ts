export const mayProcessFavoritesForMovieDna = () => true

export const mayProcessFavoritesForMatch = () => true

const loadProcessableFavorites = async <FavoriteValue>(
  mayProcess: () => boolean,
  loadFavorites: () => Promise<FavoriteValue[]>,
) => {
  if (!mayProcess()) {
    return undefined
  }

  return loadFavorites()
}

export const loadFavoritesForMovieDna = <FavoriteValue>(
  loadFavorites: () => Promise<FavoriteValue[]>,
) => loadProcessableFavorites(mayProcessFavoritesForMovieDna, loadFavorites)

export const loadFavoritesForMatch = <FavoriteValue>(
  loadFavorites: () => Promise<FavoriteValue[]>,
) => loadProcessableFavorites(mayProcessFavoritesForMatch, loadFavorites)
