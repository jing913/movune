<script setup lang="ts">
import { ref, watch } from 'vue'
import type {
  AnnouncementRichTextBlock,
  AnnouncementRichTextDocument,
  AnnouncementRichTextInline,
} from '@/services/announcements'

type EditorBlock = {
  id: number
  kind: 'paragraph' | 'heading_2' | 'heading_3' | 'unordered_list' | 'ordered_list'
  text: string
  bold: boolean
  href: string
  original?: AnnouncementRichTextBlock
  edited: boolean
}

const props = defineProps<{
  modelValue?: AnnouncementRichTextDocument
  disabled?: boolean
  error?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: AnnouncementRichTextDocument] }>()
let nextId = 1
let syncing = false
let lastEmitted = ''
const blocks = ref<EditorBlock[]>([])

function inlineText(content: readonly AnnouncementRichTextInline[]) {
  return content.map((item) => (item.type === 'text' ? item.text : '\n')).join('')
}

function blockText(block: AnnouncementRichTextBlock): string {
  if (block.type === 'paragraph' || block.type === 'heading') return inlineText(block.content)
  return block.content
    .map((item) => item.content.map((child) => blockText(child)).join(' '))
    .join('\n')
}

function fromDocument(document?: AnnouncementRichTextDocument): EditorBlock[] {
  if (!document)
    return [{ id: nextId++, kind: 'paragraph', text: '', bold: false, href: '', edited: true }]
  return document.content.map((block) => {
    if (block.type === 'unordered_list' || block.type === 'ordered_list') {
      return {
        id: nextId++,
        kind: block.type,
        text: blockText(block),
        bold: false,
        href: '',
        original: block,
        edited: false,
      }
    }
    const inlineContent =
      block.type === 'paragraph' || block.type === 'heading' ? block.content : []
    const firstText = inlineContent.find((item) => item.type === 'text')
    return {
      id: nextId++,
      kind: block.type === 'heading' ? `heading_${block.level}` : 'paragraph',
      text: inlineText(inlineContent),
      bold: firstText?.marks?.some((mark) => mark.type === 'bold') ?? false,
      href: firstText?.marks?.find((mark) => mark.type === 'link')?.href ?? '',
      original: block,
      edited: false,
    } as EditorBlock
  })
}

function safeHref(value: string) {
  if (!value) return true
  if (value !== value.trim()) return false
  if (value.startsWith('/')) return !value.startsWith('//')
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function inlines(block: EditorBlock): AnnouncementRichTextInline[] {
  const marks = [
    ...(block.bold ? [{ type: 'bold' as const }] : []),
    ...(block.href && safeHref(block.href) ? [{ type: 'link' as const, href: block.href }] : []),
  ]
  const lines = block.text.split('\n')
  return lines.flatMap((text, index) => [
    { type: 'text' as const, text, ...(marks.length ? { marks } : {}) },
    ...(index < lines.length - 1 ? [{ type: 'line_break' as const }] : []),
  ])
}

function toBlock(block: EditorBlock): AnnouncementRichTextBlock {
  if (block.kind === 'unordered_list' || block.kind === 'ordered_list') {
    return {
      type: block.kind,
      content: block.text.split('\n').map((text) => ({
        type: 'list_item' as const,
        content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
      })),
    }
  }
  if (block.kind === 'heading_2' || block.kind === 'heading_3') {
    return { type: 'heading', level: block.kind === 'heading_2' ? 2 : 3, content: inlines(block) }
  }
  return { type: 'paragraph', content: inlines(block) }
}

function publish() {
  if (syncing) return
  const document: AnnouncementRichTextDocument = {
    type: 'document',
    content: blocks.value.map((block) =>
      !block.edited && block.original ? block.original : toBlock(block),
    ),
  }
  lastEmitted = JSON.stringify(document)
  emit('update:modelValue', document)
}

function editBlock(block: EditorBlock) {
  block.edited = true
  publish()
}

function addBlock() {
  blocks.value.push({
    id: nextId++,
    kind: 'paragraph',
    text: '',
    bold: false,
    href: '',
    edited: true,
  })
  publish()
}

function removeBlock(index: number) {
  if (blocks.value.length === 1) return
  blocks.value.splice(index, 1)
  publish()
}

watch(
  () => props.modelValue,
  (value) => {
    if (JSON.stringify(value) === lastEmitted) return
    syncing = true
    blocks.value = fromDocument(value)
    syncing = false
  },
  { immediate: true },
)
</script>

<template>
  <fieldset class="space-y-4" :disabled="disabled">
    <legend class="text-base font-bold">公告內容</legend>
    <p class="text-sm text-muted-foreground">使用限定的段落、標題、清單、粗體與安全連結。</p>
    <div
      v-for="(block, index) in blocks"
      :key="block.id"
      class="rounded-lg border border-border bg-card p-4"
    >
      <div class="flex flex-wrap items-center gap-3">
        <label class="text-sm font-medium">
          區塊類型
          <select
            v-model="block.kind"
            class="ml-2 min-h-11 rounded-md border border-control bg-background px-3"
            @change="editBlock(block)"
          >
            <option value="paragraph">段落</option>
            <option value="heading_2">標題 H2</option>
            <option value="heading_3">標題 H3</option>
            <option value="unordered_list">項目清單</option>
            <option value="ordered_list">編號清單</option>
          </select>
        </label>
        <button
          type="button"
          class="ml-auto min-h-11 rounded-md border border-control px-3 text-sm disabled:opacity-50"
          :disabled="blocks.length === 1"
          @click="removeBlock(index)"
        >
          移除區塊
        </button>
      </div>
      <label class="mt-3 block text-sm font-medium" :for="`body-block-${block.id}`">
        {{ block.kind.includes('list') ? '每行一個項目' : '文字' }}
      </label>
      <textarea
        :id="`body-block-${block.id}`"
        v-model="block.text"
        rows="4"
        class="mt-1 w-full rounded-md border border-control bg-background px-3 py-2"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="error ? 'announcement-body-error' : undefined"
        @input="editBlock(block)"
      ></textarea>
      <div
        v-if="!block.kind.includes('list')"
        class="mt-3 grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end"
      >
        <label class="flex min-h-11 items-center gap-2"
          ><input v-model="block.bold" type="checkbox" @change="editBlock(block)" />粗體</label
        >
        <label class="text-sm font-medium"
          >安全連結（/、http、https）
          <input
            v-model="block.href"
            type="url"
            class="mt-1 min-h-11 w-full rounded-md border border-control bg-background px-3"
            :aria-invalid="block.href !== '' && !safeHref(block.href)"
            @input="editBlock(block)"
          />
          <span
            v-if="block.href !== '' && !safeHref(block.href)"
            class="mt-1 block text-sm text-destructive"
            role="alert"
            >請輸入站內路徑或 http/https 網址。</span
          >
        </label>
      </div>
    </div>
    <p v-if="error" id="announcement-body-error" class="text-sm text-destructive" role="alert">
      {{ error }}
    </p>
    <button
      type="button"
      class="min-h-11 rounded-md border border-control px-4 font-semibold"
      @click="addBlock"
    >
      新增內容區塊
    </button>
  </fieldset>
</template>
