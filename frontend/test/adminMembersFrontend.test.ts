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

  it('compiles both member views in the existing public application', async () => {
    await Promise.all([
      vite.ssrLoadModule('/src/App.vue'),
      vite.ssrLoadModule('/src/views/admin/MemberAdminListView.vue'),
      vite.ssrLoadModule('/src/views/admin/MemberAdminDetailView.vue'),
    ])
  })

  it('guards Member routes by the server-derived capability without adding Report or Case routes', async () => {
    const [router, users, navbar] = await Promise.all([
      source('../src/router/index.ts'),
      source('../src/services/users.ts'),
      source('../src/components/AppNavbar.vue'),
    ])

    assert.match(users, /viewMembers: boolean/)
    assert.doesNotMatch(users, /viewReports/)
    assert.match(router, /requiresMemberRead\?: boolean/)
    assert.match(router, /name: 'member-admin-list'/)
    assert.match(router, /name: 'member-admin-detail'/)
    assert.match(router, /capabilities\.viewMembers !== true/)
    assert.match(router, /requiresAnnouncementManagement/)
    assert.doesNotMatch(router, /ReportAdmin|CaseAdmin|viewReports/)
    assert.match(navbar, /capabilities\.viewMembers === true/)
    assert.match(navbar, /\/admin\/members/)
    assert.match(navbar, /capabilities\.manageAnnouncements === true/)
    assert.match(navbar, /\/admin\/announcements/)
    assert.match(navbar, /會員管理/)
    assert.match(navbar, /公告管理/)
  })

  it('keeps Member pages inside the existing public DefaultLayout', async () => {
    const [app, defaultLayout, listView, detailView] = await Promise.all([
      source('../src/App.vue'),
      source('../src/layouts/DefaultLayout.vue'),
      source('../src/views/admin/MemberAdminListView.vue'),
      source('../src/views/admin/MemberAdminDetailView.vue'),
    ])

    assert.match(defaultLayout, /<AppNavbar/)
    assert.match(defaultLayout, /<AppFooter/)
    assert.match(app, /<DefaultLayout/)
    assert.doesNotMatch(app, /AdminLayout/)
    assert.match(listView, /class="page-shell py-8 sm:py-12"/)
    assert.match(detailView, /class="page-shell py-8 sm:py-12"/)
  })

  it('renders only the approved read-only member fields and no mutation controls', async () => {
    const [listView, detailView] = await Promise.all([
      source('../src/views/admin/MemberAdminListView.vue'),
      source('../src/views/admin/MemberAdminDetailView.vue'),
    ])
    const combined = `${listView}\n${detailView}`

    assert.match(combined, /最近登入/)
    assert.match(combined, /無可用資料|無資料/)
    assert.doesNotMatch(combined, /\.email|member\.password|refreshToken|resetToken/)
    assert.doesNotMatch(combined, /api\.(post|patch|put|delete)/)
    assert.doesNotMatch(combined, /停權會員|刪除會員|恢復會員/)
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
})
