import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('safety client uses the accepted Block, Unblock, and Report contracts', async () => {
  const source = await readSource('../src/services/safety.ts')

  assert.match(source, /\.put<ContactInteractionResponse>\(`\/api\/users\/\$\{[^}]+\}\/block`\)/)
  assert.match(source, /\.delete<ContactInteractionResponse>\(`\/api\/users\/\$\{[^}]+\}\/block`\)/)
  assert.match(source, /`\/api\/users\/\$\{[^}]+\}\/report`/)
  assert.match(source, /`\/api\/direct-conversations\/\$\{[^}]+\}\/report-user`/)
  assert.match(source, /'harassment_or_uncomfortable'/)
  assert.match(source, /'spam_or_suspicious'/)
})

test('shared safety actions require confirmation and preserve truthful outcomes', async () => {
  const source = await readSource('../src/components/user/UserSafetyActions.vue')

  assert.match(source, /封鎖這位使用者？/)
  assert.match(source, /過去的訊息仍會保留/)
  assert.match(source, /先前的追蹤與傳訊權限也不會自動恢復/)
  assert.match(source, /@click="confirmBlock"/)
  assert.match(source, /@click="blockOpen = false"[\s\S]*?>\s*取消/)
  assert.match(source, /blockError\.value = '目前無法封鎖/)
  assert.match(source, /檢舉已收到。/)
  assert.doesNotMatch(source, /違規成立|帳號將被停權|已完成處分/)
  assert.match(source, /reportError\.value = '目前無法送出檢舉/)
  assert.match(source, /role="alert"/)
  assert.match(source, /aria-live="polite"/)
})

test('profile and conversation surfaces expose only eligible safety actions', async () => {
  const [profile, inbox] = await Promise.all([
    readSource('../src/views/PublicProfileView.vue'),
    readSource('../src/views/InboxView.vue'),
  ])

  assert.match(profile, /v-if="followSummary && !followSummary\.isSelf"/)
  assert.match(profile, /<UserSafetyActions/)
  assert.match(inbox, /v-if="selectedDirect && directOtherUser"/)
  assert.match(inbox, /:can-block="selectedDirect\.capabilities\.canBlockUser"/)
  assert.match(inbox, /:can-unblock="selectedDirect\.capabilities\.canUnblockUser"/)
  assert.match(inbox, /:can-report="true"/)
  assert.match(inbox, /type DirectView = 'conversations' \| 'requests' \| 'ended'|activeDirectView/)
})
