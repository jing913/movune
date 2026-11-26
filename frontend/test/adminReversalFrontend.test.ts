import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import { createServer, type ViteDevServer } from 'vite'

type Module = typeof import('../src/services/adminEnforcement.ts')
let vite: ViteDevServer
let enforcement: Module

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
  })
  enforcement = (await vite.ssrLoadModule('/src/services/adminEnforcement.ts')) as Module
})

after(async () => vite.close())
const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('REV-02 Admin reversal frontend', () => {
  it('defines independent enforcement routes without weakening Member Admin routes', async () => {
    const [router, layout] = await Promise.all([
      source('../src/router/index.ts'),
      source('../src/layouts/AdminLayout.vue'),
    ])
    assert.match(router, /path: 'enforcement'/)
    assert.match(router, /path: 'enforcement\/:memberId'/)
    assert.match(router, /name: 'member-enforcement-home'/)
    assert.match(router, /requiredAdminCapability: 'enforceMembers'/)
    assert.match(router, /path: 'members'[\s\S]*?requiredAdminCapability: 'viewMembers'/)
    assert.match(router, /path: 'members\/:memberId'[\s\S]*?requiredAdminCapability: 'viewMembers'/)
    assert.match(layout, /capabilities\.enforceMembers === true/)
    assert.match(layout, /to: '\/admin\/enforcement'/)
    assert.match(layout, /label: '會員撤銷'/)
  })

  it('separates enforcement-only requests before any general member fetch', async () => {
    const view = await source('../src/views/admin/MemberAdminDetailView.vue')
    assert.match(view, /if \(enforcementOnly\.value\) \{\s*\/\/ Data-isolation boundary/)
    assert.match(
      view,
      /await loadEnforcement\(memberId\.value, version\)[\s\S]*?\} else \{\s*member\.value = await getAdminMember/,
    )
    assert.match(view, /本頁不提供會員目錄或一般會員資料查詢/)
    for (const sensitive of [
      'member.email',
      'privateMetadata',
      'reporter',
      'investigationEvidence',
    ]) {
      assert.equal(view.includes(sensitive), false, sensitive)
    }
  })

  it('retains the exact operationId and payload for explicit unknown-outcome retry', async () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value)
      },
      removeItem: (key: string) => {
        memory.delete(key)
      },
    }
    const calls: unknown[] = []
    const command = {
      actorId: '111111111111111111111111',
      decisionId: '222222222222222222222222',
      operationId: 'reversal.web.exact-retry',
      reasonSummary: 'Exact internal reason',
      memberFacingReasonCode: 'warning_reversed_after_review_v1',
    }
    let attempt = 0
    const coordinator = enforcement.createAdminReversalCommandCoordinator({
      storage,
      execute: async (decisionId, body) => {
        calls.push({ decisionId, body })
        attempt += 1
        if (attempt === 1) {
          throw new axios.AxiosError('unconfirmed', 'ERR_BAD_RESPONSE', {} as never, null, {
            status: 503,
            statusText: 'Service Unavailable',
            headers: {},
            config: {} as never,
            data: {
              error: {
                code: 'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED',
                details: { operationId: command.operationId, retryWithSameOperationId: true },
              },
            },
          })
        }
        return {
          kind: 'replayed',
          operationId: body.operationId,
          reversal: {
            id: '333333333333333333333333',
            targetUserId: command.decisionId,
            performedByUserId: command.actorId,
            reversesDecisionId: decisionId,
            effectiveAt: '2035-09-01T00:00:00.000Z',
            reasonCode: 'admin.reversal',
            reasonSummary: body.reasonSummary,
          },
        } as const
      },
    })
    const first = await coordinator.executeNew(command)
    assert.equal(first.kind, 'uncertain')
    assert.deepEqual(coordinator.inspect(command.actorId).command, command)
    const retried = await coordinator.retry(command.actorId)
    assert.equal(retried.kind, 'success')
    assert.deepEqual(calls[0], calls[1])
    assert.equal(coordinator.inspect(command.actorId).command, null)
  })

  it('requires truthful re-review confirmation and provides accessible feedback hooks', async () => {
    const view = await source('../src/views/admin/MemberAdminDetailView.vue')
    assert.match(view, /我確認已實際完成重新審查/)
    assert.match(view, /!rereviewConfirmed\.value/)
    assert.match(view, /<Dialog :open="confirmationOpen" :modal="true"/)
    assert.match(view, /<DialogTitle class="text-xl font-bold"/)
    assert.match(view, /<DialogDescription/)
    assert.equal(view.includes('id="reversal-confirm-title"'), false)
    assert.match(view, /role="alert"/)
    assert.match(view, /role="status"/)
    assert.match(view, /min-h-11/)
    assert.match(view, /break-words/)
  })

  it('uses the project modal contract without weakening reversal state safety', async () => {
    const view = await source('../src/views/admin/MemberAdminDetailView.vue')
    assert.match(view, /from '@\/components\/ui\/dialog'/)
    assert.match(view, /<DialogTitle[\s\S]*?確認撤銷/)
    assert.match(view, /<DialogDescription[\s\S]*?原決定會保留/)
    assert.equal(view.includes('console.warn'), false)
    assert.match(view, /@open-auto-focus="handleConfirmationOpenAutoFocus"/)
    assert.match(view, /internalReasonInput\.value\?\.focus\(\{ preventScroll: true \}\)/)
    assert.match(view, /@close-auto-focus="handleConfirmationCloseAutoFocus"/)
    assert.match(view, /invoker\?\.isConnected/)
    assert.match(view, /dialogFallback\.value\?\.focus/)
    assert.match(view, /@pointer-down-outside="preventConfirmationOutsideInteraction"/)
    assert.match(view, /@interact-outside="preventConfirmationOutsideInteraction"/)
    assert.match(view, /if \(open \|\| commandState\.value !== 'confirming'\) return/)
    assert.match(view, /@click="requestConfirmation\(decision, \$event\)"/)
    assert.match(view, /function cancelConfirmation\(\) \{[\s\S]*?resetCommand\(\)/)
    assert.match(view, /@click="cancelConfirmation"/)
    assert.match(view, /if \(!restoreInvoker\) \{[\s\S]*?commandStatus\.value\?\.focus/)
    assert.equal(view.includes("<section\n        v-if=\"commandState === 'confirming'"), false)

    // Existing command, validation, append-only, and privacy contracts remain source-visible.
    assert.match(view, /reasonSummary\.length < 1 \|\| \[\.\.\.reasonSummary\]\.length > 1000/)
    assert.match(view, /memberFacingReasonCode: publicReasonCode\.value/)
    assert.match(view, /operationId: createAdminReversalOperationId\(\)/)
    assert.match(view, /原決定會保留，系統只會附加一筆不可變更的撤銷紀錄/)
    assert.match(view, /result\.response\.kind === 'replayed'/)
    assert.match(view, /await loadPage\(\)/)
    assert.match(view, /v-if="decision\.reversal"/)
  })
})
