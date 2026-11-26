import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('approved Admin UI recovery', () => {
  it('restores the approved independent Admin shell and logout semantics', async () => {
    const layout = await source('../src/layouts/AdminLayout.vue')
    const desktopSidebar = layout.match(/<aside[\s\S]*?<\/aside>/)?.[0] ?? ''

    assert.doesNotMatch(layout, /Administration|管理員工作區/)
    assert.match(desktopSidebar, /aria-label="目前管理員"/)
    assert.match(desktopSidebar, /administratorInitial/)
    assert.match(desktopSidebar, /administratorName/)
    assert.match(desktopSidebar, /administratorAccount/)
    assert.equal((layout.match(/@click="handleLogout"/g) ?? []).length, 2)
    assert.match(layout, /await userStore\.logout\(\)/)
    assert.match(layout, /isMobileNavigationOpen\.value = false/)
    assert.match(layout, /await router\.push\('\/'\)/)
    assert.equal((layout.match(/返回 Movune/g) ?? []).length, 2)
  })

  it('uses a capability-bounded native disclosure on desktop and mobile', async () => {
    const layout = await source('../src/layouts/AdminLayout.vue')

    assert.match(layout, /capabilities\.viewReports === true/)
    assert.equal((layout.match(/v-if="canViewReports"/g) ?? []).length, 2)
    assert.equal((layout.match(/:aria-expanded="isReviewCenterExpanded"/g) ?? []).length, 2)
    assert.equal(
      (layout.match(/@click="isReviewCenterExpanded = !isReviewCenterExpanded"/g) ?? []).length,
      2,
    )
    assert.match(layout, /aria-controls="desktop-review-center-navigation"/)
    assert.match(layout, /id="desktop-review-center-navigation"/)
    assert.match(layout, /aria-controls="mobile-review-center-navigation"/)
    assert.match(layout, /id="mobile-review-center-navigation"/)
    assert.equal((layout.match(/v-show="isReviewCenterExpanded"/g) ?? []).length, 2)
    assert.match(layout, /isReviewCenterExpanded && 'rotate-180'/)
    assert.match(layout, /focus-visible:outline-amber-300/)
    assert.match(layout, /focus-visible:outline-amber-700/)
    assert.match(layout, /path\.startsWith\('\/admin\/reports'\)/)
    assert.match(layout, /path\.startsWith\('\/admin\/cases'\)/)
    assert.match(layout, /isReviewCenterExpanded\.value = true/)
    assert.match(layout, /to="\/admin\/reports"/)
    assert.match(layout, /to="\/admin\/cases"/)
  })

  it('restores the approved compact Announcement presentation and later governance guard', async () => {
    const [list, editor, form, bodyEditor] = await Promise.all([
      source('../src/views/admin/AnnouncementAdminListView.vue'),
      source('../src/views/admin/AnnouncementAdminEditorView.vue'),
      source('../src/components/admin/announcement/AnnouncementAdminForm.vue'),
      source('../src/components/admin/announcement/AnnouncementBodyEditor.vue'),
    ])

    assert.match(list, /<section>/)
    assert.doesNotMatch(list, /page-shell|>\s*Administration\s*</)
    assert.match(list, /text-2xl font-bold tracking-tight sm:text-3xl/)
    assert.match(list, /rounded-xl border border-border bg-card p-4 shadow-sm/)
    assert.match(editor, /record && record\.governanceStatus !== 'normal'/)
    assert.doesNotMatch(editor, /Announcement Admin|page-shell/)
    assert.match(editor, /sticky bottom-0 z-20 mt-6/)
    assert.match(form, /<form class="space-y-6"/)
    assert.match(form, /grid gap-4 rounded-xl border border-border bg-card p-4 shadow-sm/)
    assert.match(form, /mt-1\.5 min-h-11 w-full rounded-lg/)
    assert.match(bodyEditor, /<legend class="text-base font-semibold">公告內容<\/legend>/)
    assert.doesNotMatch(`${form}\n${bodyEditor}`, /rounded-md/)
  })

  it('retains Stage B enforcement and member notice production wiring', async () => {
    const [caseDetail, casesService, router, navbar, users] = await Promise.all([
      source('../src/views/admin/CaseAdminDetailView.vue'),
      source('../src/services/adminCases.ts'),
      source('../src/router/index.ts'),
      source('../src/components/AppNavbar.vue'),
      source('../src/services/users.ts'),
    ])

    assert.match(caseDetail, /value="no_action"/)
    assert.match(caseDetail, /value="formal_warning"/)
    assert.match(casesService, /\/api\/admin\/cases\/enforcement-guidelines/)
    assert.match(router, /requiredAdminCapability: 'viewReports'/)
    assert.match(router, /requiredAdminCapability: 'viewMembers'/)
    assert.match(router, /requiredAdminCapability: 'manageAnnouncements'/)
    assert.match(router, /enforcement-notices/)
    assert.match(navbar, /enforcement-notices/)
    assert.match(users, /getMyEnforcementNotices/)
  })
})
