import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

type AdminMembersModule = typeof import('../src/services/adminMembers.ts')
type ApiModule = typeof import('../src/services/api.ts')

let vite: ViteDevServer
let adminMembers: AdminMembersModule
let apiModule: ApiModule

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
  })
  ;[adminMembers, apiModule] = await Promise.all([
    vite.ssrLoadModule('/src/services/adminMembers.ts') as Promise<AdminMembersModule>,
    vite.ssrLoadModule('/src/services/api.ts') as Promise<ApiModule>,
  ])
})

after(async () => {
  await vite.close()
})

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
const member = {
  id: '507f1f77bcf86cd799439011',
  avatar: null,
  displayName: 'Example Member',
  account: 'example',
  accountStatus: 'active' as const,
  registrationDate: '2026-10-15T00:00:00.000Z',
  recentLogin: { status: 'unavailable' as const, at: null },
}

describe('Admin Members frontend slice', () => {
  it('uses only the dedicated read endpoints and preserves approved query names', async () => {
    const calls: Array<{ url: string; config?: { params?: unknown } }> = []
    const originalGet = apiModule.default.get
    apiModule.default.get = (async (url: string, config?: { params?: unknown }) => {
      calls.push({ url, config })
      return url.endsWith(member.id)
        ? { data: { member: { ...member, bio: null, role: 'user' } } }
        : {
            data: {
              members: [member],
              pagination: { page: 2, limit: 20, total: 21, totalPages: 2 },
            },
          }
    }) as typeof apiModule.default.get

    try {
      const query = {
        search: 'Example',
        status: 'active' as const,
        role: 'user' as const,
        registeredFrom: '2026-01-01',
        registeredTo: '2026-10-15',
        page: 2,
        limit: 20,
      }
      const list = await adminMembers.listAdminMembers(query)
      const detail = await adminMembers.getAdminMember(member.id)

      assert.deepEqual(list.members, [member])
      assert.equal(detail.role, 'user')
      assert.deepEqual(calls, [
        { url: '/api/admin/members', config: { params: query } },
        { url: `/api/admin/members/${member.id}`, config: undefined },
      ])
      assert.deepEqual(Object.keys(list.members[0]!).sort(), [
        'account',
        'accountStatus',
        'avatar',
        'displayName',
        'id',
        'recentLogin',
        'registrationDate',
      ])
    } finally {
      apiModule.default.get = originalGet
    }
  })

  it('rejects malformed identifiers and unexpected response shapes', async () => {
    let calls = 0
    const originalGet = apiModule.default.get
    apiModule.default.get = (async () => {
      calls += 1
      return { data: { members: [{ ...member, email: 'must-not-pass@example.test' }] } }
    }) as typeof apiModule.default.get

    try {
      await assert.rejects(() => adminMembers.getAdminMember('not-an-object-id'), {
        message: 'ADMIN_MEMBER_ID_INVALID',
      })
      assert.equal(calls, 0)
      await assert.rejects(() => adminMembers.listAdminMembers({}), {
        message: 'ADMIN_MEMBER_RESPONSE_INVALID',
      })
    } finally {
      apiModule.default.get = originalGet
    }
  })

  it('strips unapproved fields even if a server response unexpectedly includes one', async () => {
    const originalGet = apiModule.default.get
    apiModule.default.get = (async () => ({
      data: {
        members: [{ ...member, email: 'must-not-pass@example.test' }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      },
    })) as typeof apiModule.default.get

    try {
      const response = await adminMembers.listAdminMembers({})
      assert.equal('email' in response.members[0]!, false)
    } finally {
      apiModule.default.get = originalGet
    }
  })

  it('compiles the layout and both member views', async () => {
    await Promise.all([
      vite.ssrLoadModule('/src/App.vue'),
      vite.ssrLoadModule('/src/layouts/AdminLayout.vue'),
      vite.ssrLoadModule('/src/views/admin/MemberAdminListView.vue'),
      vite.ssrLoadModule('/src/views/admin/MemberAdminDetailView.vue'),
    ])
  })

  it('guards every admin destination by its server-derived capability', async () => {
    const [router, users, navbar] = await Promise.all([
      source('../src/router/index.ts'),
      source('../src/services/users.ts'),
      source('../src/components/AppNavbar.vue'),
    ])

    assert.match(users, /viewMembers: boolean/)
    assert.match(router, /requiredAdminCapability: 'viewMembers'/)
    assert.match(router, /requiredAdminCapability: 'manageAnnouncements'/)
    assert.match(router, /userStore\.currentUser\?\.capabilities\[requiredCapability\] !== true/)
    assert.match(router, /to\.name === 'admin-home'/)
    assert.match(navbar, /hasAdminConsoleAccess/)
    assert.match(navbar, />\s*管理員後台\s*</)
  })

  it('keeps public chrome outside the independent Admin route shell', async () => {
    const [app, defaultLayout, router, main, adminLayout] = await Promise.all([
      source('../src/App.vue'),
      source('../src/layouts/DefaultLayout.vue'),
      source('../src/router/index.ts'),
      source('../src/main.ts'),
      source('../src/layouts/AdminLayout.vue'),
    ])

    assert.match(defaultLayout, /<AppNavbar/)
    assert.match(defaultLayout, /<AppFooter/)
    assert.match(app, /route\.meta\.layout === 'admin'/)
    assert.match(app, /<RouterView v-if="usesAdminLayout"/)
    assert.match(app, /<DefaultLayout v-else/)
    assert.doesNotMatch(app, /AppNavbar|AppFooter/)
    assert.match(router, /meta: \{ layout: 'admin', requiresAuth: true \}/)
    assert.match(main, /router\.isReady\(\)/)
    assert.doesNotMatch(adminLayout, /AppNavbar|AppFooter/)
  })

  it('provides a bounded responsive Admin identity and navigation shell', async () => {
    const layout = await source('../src/layouts/AdminLayout.vue')

    assert.match(layout, /返回 Movune/)
    assert.match(layout, /administratorName/)
    assert.match(layout, /administratorAccount/)
    assert.match(layout, /aria-label="目前管理員"/)
    assert.match(layout, /aria-controls="admin-mobile-navigation"/)
    assert.match(layout, /:aria-expanded="isMobileNavigationOpen"/)
    assert.match(layout, /min-h-dvh/)
    assert.match(layout, /overflow-x-clip/)
    assert.doesNotMatch(layout, /overflow-x-hidden/)
    assert.match(layout, /max-w-\[96rem\]/)
    assert.doesNotMatch(layout, /編輯會員|停權會員|刪除會員|報表管理/)
  })

  it('preserves approved general member fields while isolating enforcement controls', async () => {
    const [listView, detailView] = await Promise.all([
      source('../src/views/admin/MemberAdminListView.vue'),
      source('../src/views/admin/MemberAdminDetailView.vue'),
    ])
    const combined = `${listView}\n${detailView}`

    assert.match(combined, /最近登入/)
    assert.match(combined, /無可用資料|無資料/)
    assert.doesNotMatch(combined, /\.email|member\.password|refreshToken|resetToken/)
    assert.doesNotMatch(combined, /停權會員|刪除會員|恢復會員/)
    assert.match(detailView, /if \(enforcementOnly\.value\)/)
    assert.match(detailView, /await loadEnforcement\(memberId\.value, version\)/)
    assert.match(detailView, /else \{\s*member\.value = await getAdminMember/)
  })

  it('moves focus to the Admin main landmark only when the route path changes', async () => {
    const layout = await source('../src/layouts/AdminLayout.vue')

    assert.match(layout, /const adminMain = ref<HTMLElement \| null>\(null\)/)
    assert.match(layout, /\(\) => route\.path/)
    assert.match(layout, /await nextTick\(\)/)
    assert.match(layout, /adminMain\.value\?\.focus\(\{ preventScroll: true \}\)/)
    assert.match(layout, /tabindex="-1"/)
    assert.match(layout, /\{ flush: 'post' \}/)
  })

  it('keeps the full member display name visibly readable on narrow screens', async () => {
    const detailView = await source('../src/views/admin/MemberAdminDetailView.vue')
    const headings = [...detailView.matchAll(/<h2 id="member-detail-title"[^>]*>/g)].map(
      ([heading]) => heading,
    )
    const memberHeading = headings.find((heading) => heading.includes('break-words'))

    assert.ok(memberHeading)
    assert.doesNotMatch(memberHeading, /truncate/)
  })

  it('contains long mobile member identities without clipping the detail action', async () => {
    const listView = await source('../src/views/admin/MemberAdminListView.vue')
    const mobileHeading = listView.match(
      /<h3 class="([^"]+)">\s*\{\{ member\.displayName \}\}\s*<\/h3>/,
    )

    assert.match(listView, /class="grid min-w-0 gap-3 md:hidden"/)
    assert.match(listView, /class="min-w-0 rounded-xl border border-slate-200/)
    assert.match(listView, /class="flex min-w-0 items-start gap-3"/)
    assert.match(listView, /class="min-w-0 flex-1"/)
    assert.ok(mobileHeading)
    assert.match(mobileHeading[1]!, /break-words/)
    assert.match(mobileHeading[1]!, /whitespace-normal/)
    assert.doesNotMatch(mobileHeading[1]!, /truncate|overflow-hidden/)
    assert.match(listView, /<p class="break-all text-sm text-slate-500">@/)
    assert.match(listView, /query: detailQuery/)
    assert.match(listView, /class="mt-4 inline-flex min-h-11 w-full min-w-0[^"]*"/)
    assert.match(listView, />查看會員<\/RouterLink/)
    for (const label of ['狀態', '註冊日期', '最近登入']) assert.match(listView, new RegExp(label))
  })

  it('shows the Announcement governance banner only for restricted existing records', async () => {
    const announcementEditor = await source('../src/views/admin/AnnouncementAdminEditorView.vue')
    const showsBanner = (record: null | { governanceStatus: 'normal' | 'exceptionally_removed' }) =>
      record !== null && record.governanceStatus !== 'normal'

    assert.equal(showsBanner(null), false, 'a new announcement must not show the banner')
    assert.equal(
      showsBanner({ governanceStatus: 'normal' }),
      false,
      'an existing normal announcement must not show the banner',
    )
    assert.equal(
      showsBanner({ governanceStatus: 'exceptionally_removed' }),
      true,
      'an existing restricted announcement must show the banner',
    )
    assert.match(
      announcementEditor,
      /v-if="record && record\.governanceStatus !== 'normal'"[\s\S]*此公告受治理限制，無法在此工作區編輯。/,
    )
    assert.doesNotMatch(announcementEditor, /v-if="record\?\.governanceStatus !== 'normal'"/)
    assert.match(announcementEditor, /v-else-if="record\?\.governanceStatus === 'normal'"/)
    assert.match(
      announcementEditor,
      /record\?\.publicationStatus === 'withdrawn'/,
      'a withdrawn announcement must keep its editor disabled',
    )
  })
})
