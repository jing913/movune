import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
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
import EnforcementNoticesView from '@/views/EnforcementNoticesView.vue'
import AnnouncementAdminListView from '@/views/admin/AnnouncementAdminListView.vue'
import AnnouncementAdminEditorView from '@/views/admin/AnnouncementAdminEditorView.vue'
import MemberAdminListView from '@/views/admin/MemberAdminListView.vue'
import MemberAdminDetailView from '@/views/admin/MemberAdminDetailView.vue'
import ReportAdminListView from '@/views/admin/ReportAdminListView.vue'
import ReportAdminDetailView from '@/views/admin/ReportAdminDetailView.vue'
import CaseAdminListView from '@/views/admin/CaseAdminListView.vue'
import CaseAdminDetailView from '@/views/admin/CaseAdminDetailView.vue'
import AdminLayout from '@/layouts/AdminLayout.vue'
import { useUserStore } from '@/stores/user'
import type { User } from '@/services/users'

export type AdminCapability = keyof User['capabilities']

export function firstAuthorizedAdminRoute(capabilities: User['capabilities']) {
  if (capabilities.viewReports === true) return { name: 'report-admin-list' }
  if (capabilities.viewMembers === true) return { name: 'member-admin-list' }
  if (capabilities.enforceMembers === true) return { name: 'member-enforcement-home' }
  if (capabilities.manageAnnouncements === true) return { name: 'announcement-admin-list' }
  return { path: '/' }
}

declare module 'vue-router' {
  interface RouteMeta {
    layout?: 'admin'
    requiresAuth?: boolean
    requiredAdminCapability?: AdminCapability
  }
}

const routes: RouteRecordRaw[] = [
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
    meta: {
      requiresAuth: true,
    },
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
    path: '/account/enforcement-notices',
    name: 'enforcement-notices',
    component: EnforcementNoticesView,
    meta: { requiresAuth: true },
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
  {
    path: '/admin',
    name: 'admin-home',
    component: AdminLayout,
    meta: { layout: 'admin', requiresAuth: true },
    children: [
      {
        path: 'reports',
        name: 'report-admin-list',
        component: ReportAdminListView,
        meta: { requiresAuth: true, requiredAdminCapability: 'viewReports' },
      },
      {
        path: 'reports/:reportId',
        name: 'report-admin-detail',
        component: ReportAdminDetailView,
        meta: { requiresAuth: true, requiredAdminCapability: 'viewReports' },
      },
      {
        path: 'cases',
        name: 'case-admin-list',
        component: CaseAdminListView,
        meta: { requiresAuth: true, requiredAdminCapability: 'viewReports' },
      },
      {
        path: 'cases/:reportId',
        name: 'case-admin-detail',
        component: CaseAdminDetailView,
        meta: { requiresAuth: true, requiredAdminCapability: 'viewReports' },
      },
      {
        path: 'enforcement',
        name: 'member-enforcement-home',
        component: MemberAdminDetailView,
        meta: { requiresAuth: true, requiredAdminCapability: 'enforceMembers' },
      },
      {
        path: 'enforcement/:memberId',
        name: 'member-enforcement-detail',
        component: MemberAdminDetailView,
        meta: { requiresAuth: true, requiredAdminCapability: 'enforceMembers' },
      },
      {
        path: 'members',
        name: 'member-admin-list',
        component: MemberAdminListView,
        meta: { requiresAuth: true, requiredAdminCapability: 'viewMembers' },
      },
      {
        path: 'members/:memberId',
        name: 'member-admin-detail',
        component: MemberAdminDetailView,
        meta: { requiresAuth: true, requiredAdminCapability: 'viewMembers' },
      },
      {
        path: 'announcements',
        name: 'announcement-admin-list',
        component: AnnouncementAdminListView,
        meta: { requiresAuth: true, requiredAdminCapability: 'manageAnnouncements' },
      },
      {
        path: 'announcements/new',
        name: 'announcement-admin-new',
        component: AnnouncementAdminEditorView,
        meta: { requiresAuth: true, requiredAdminCapability: 'manageAnnouncements' },
      },
      {
        path: 'announcements/:announcementId',
        name: 'announcement-admin-editor',
        component: AnnouncementAdminEditorView,
        meta: { requiresAuth: true, requiredAdminCapability: 'manageAnnouncements' },
      },
    ],
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

  if (to.name === 'admin-home') {
    return firstAuthorizedAdminRoute(
      userStore.currentUser?.capabilities ?? {
        viewMembers: false,
        viewReports: false,
        reviewCases: false,
        enforceMembers: false,
        manageAnnouncements: false,
      },
    )
  }

  const requiredCapability = to.meta.requiredAdminCapability
  if (requiredCapability && userStore.currentUser?.capabilities[requiredCapability] !== true) {
    return { name: 'admin-home' }
  }
})

export default router
