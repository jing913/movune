import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const readFrontendSource = (path) =>
  readFile(new URL(`../../frontend/src/${path}`, import.meta.url), 'utf8')

describe('Historical Announcement frontend display contract', () => {
  it('renders the historical day label and preserves the ordinary publication label', async () => {
    for (const path of ['views/AnnouncementCenterView.vue', 'views/AnnouncementDetailView.vue']) {
      const source = await readFrontendSource(path)
      assert.ok(source.includes('上線於 {{ formatHistoricalDate(announcement.effectiveAt) }}'))
      assert.ok(source.includes('發布於 {{'))
      assert.ok(source.includes("padStart(2, '0')"))
    }
  })

  it('extends only the public DTO and adds no historical admin controls', async () => {
    const publicService = await readFrontendSource('services/announcements.ts')
    assert.ok(publicService.includes('effectiveAt?: string'))

    for (const path of [
      'services/adminAnnouncements.ts',
      'components/admin/announcement/AnnouncementAdminForm.vue',
      'views/admin/AnnouncementAdminEditorView.vue',
    ]) {
      const source = await readFrontendSource(path)
      assert.equal(source.includes('effectiveAt'), false)
      assert.equal(source.includes('historical-publish'), false)
    }
  })
})
