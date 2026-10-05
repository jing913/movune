import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '@/views/HomeView.vue'
import ExploreMoviesView from '@/views/ExploreMoviesView.vue'
import MovieDetailView from '@/views/MovieDetailView.vue'
import MovieSpaceView from '@/views/MovieSpaceView.vue'
import ResetPasswordView from '@/views/ResetPasswordView.vue'
import ExplorePeopleView from '@/views/ExplorePeopleView.vue'
import PublicProfileView from '@/views/PublicProfileView.vue'
import PublicMovieSpaceView from '@/views/PublicMovieSpaceView.vue'
import EncounterView from '@/views/EncounterView.vue'
import InboxView from '@/views/InboxView.vue'
import CollectionDetailView from '@/views/CollectionDetailView.vue'
import AnnouncementCenterView from '@/views/AnnouncementCenterView.vue'
import AnnouncementDetailView from '@/views/AnnouncementDetailView.vue'
import { useUserStore } from '@/stores/user'

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean
  }
}

const routes = [
  {
    path: '/',
    component: HomeView,
  },
  {
    path: '/explore',
    component: ExploreMoviesView,
  },
  {
    path: '/movies/:id',
    component: MovieDetailView,
  },
  {
    path: '/collections/:id',
    name: 'collection-detail',
    component: CollectionDetailView,
  },
  {
    path: '/movie-space',
    name: 'movie-space',
    component: MovieSpaceView,
    meta: {
      requiresAuth: true,
    },
  },
  {
    path: '/people',
    name: 'people',
    component: ExplorePeopleView,
    meta: {
      requiresAuth: true,
    },
  },
  {
    path: '/encounter',
    name: 'encounter',
    component: EncounterView,
    meta: {
      requiresAuth: true,
    },
  },
  {
    path: '/inbox',
    name: 'inbox',
    component: InboxView,
    meta: {
      requiresAuth: true,
    },
  },
  {
    path: '/people/:id',
    name: 'public-movie-space',
    component: PublicProfileView,
    meta: {
      requiresAuth: true,
    },
  },
  {
    path: '/people/:id/movie-space',
    name: 'public-user-movie-space',
    component: PublicMovieSpaceView,
    meta: {
      requiresAuth: true,
    },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: ResetPasswordView,
  },
  {
    path: '/announcements',
    name: 'announcement-center',
    component: AnnouncementCenterView,
  },
  {
    path: '/announcements/:announcementId',
    name: 'announcement-detail',
    component: AnnouncementDetailView,
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(_to, _from, savedPosition) {
    if (!savedPosition) return { left: 0, top: 0 }

    // Async movie grids need one render cycle before the previous document height exists again.
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(savedPosition), 250)
    })
  },
})

router.beforeEach(async (to) => {
  const userStore = useUserStore()

  if (userStore.isAuthLoading) {
    await userStore.restoreAuth()
  }

  if (to.meta.requiresAuth && !userStore.isLoggedIn) {
    return {
      path: '/',
      query: {
        login: 'required',
        redirect: to.fullPath,
      },
    }
  }
})

export default router
