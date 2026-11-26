import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('member-visible Formal Warning frontend', () => {
  it('uses a dedicated member projection and presents only the approved bounded fields', async () => {
    const [service, view, router] = await Promise.all([
      readFile(new URL('../src/services/users.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/views/EnforcementNoticesView.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/router/index.ts', import.meta.url), 'utf8'),
    ])
    assert.match(service, /\/api\/users\/me\/enforcement-notices/)
    assert.match(service, /actionType: 'formal_warning'/)
    assert.match(service, /recordedAt: string/)
    assert.match(service, /status: 'recorded' \| 'reversed' \| 'legacy_reversed'/)
    assert.match(service, /reversedAt\?: string/)
    assert.match(service, /reversalReason\?: string/)
    assert.match(service, /reason: string/)
    assert.match(service, /guideline: \{ ruleId: string; version: string; title: string \}/)
    assert.match(view, /正式警告是治理紀錄，不會暫停或限制你的日常帳戶功能/)
    assert.match(view, /notice\.reason/)
    assert.match(view, /notice\.guideline\.ruleId/)
    assert.match(view, /notice\.guideline\.title/)
    assert.match(view, /notice\.guideline\.version/)
    assert.match(view, /notice\.status !== 'recorded'/)
    assert.match(view, /此正式警告已撤銷/)
    assert.match(view, /notice\.reversalReason/)
    assert.match(router, /path: '\/account\/enforcement-notices'/)
    for (const forbidden of [
      'reporterUserId',
      'privateEvidence',
      'internalRationale',
      'performedByUserId',
    ]) {
      assert.equal(view.includes(forbidden), false, forbidden)
    }
  })
})
