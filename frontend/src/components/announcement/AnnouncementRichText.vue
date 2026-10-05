<script lang="ts">
import { defineComponent, h, type PropType, type VNodeChild } from 'vue'
import { RouterLink } from 'vue-router'
import type { AnnouncementRichTextDocument } from '@/services/announcements'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const safeHrefKind = (value: unknown): 'internal' | 'external' | null => {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null
  if (value.startsWith('/')) return value.startsWith('//') ? null : 'internal'
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? 'external' : null
  } catch {
    return null
  }
}

const renderInline = (inline: unknown, key: string): VNodeChild => {
  if (!isRecord(inline) || typeof inline.type !== 'string') return null
  if (inline.type === 'line_break') return h('br', { key })
  if (inline.type !== 'text' || typeof inline.text !== 'string') return null

  const marks = inline.marks === undefined ? [] : inline.marks
  if (!Array.isArray(marks)) return null
  if (
    marks.some(
      (mark) =>
        !isRecord(mark) ||
        (mark.type !== 'bold' && (mark.type !== 'link' || safeHrefKind(mark.href) === null)),
    )
  ) {
    return null
  }

  let rendered: VNodeChild = inline.text
  for (const mark of marks) {
    if (!isRecord(mark)) return null
    const child: VNodeChild = rendered
    if (mark.type === 'bold') {
      rendered = h('strong', { class: 'font-bold text-foreground' }, [child])
      continue
    }
    if (mark.type !== 'link' || typeof mark.href !== 'string') return null
    const hrefKind = safeHrefKind(mark.href)
    if (hrefKind === 'internal') {
      rendered = h(
        RouterLink,
        {
          to: mark.href,
          class:
            'break-words text-accent-caramel underline decoration-accent-caramel/50 underline-offset-4 hover:text-accent-caramel-light',
        },
        { default: () => [child] },
      )
    } else if (hrefKind === 'external') {
      rendered = h(
        'a',
        {
          href: mark.href,
          target: '_blank',
          rel: 'noopener noreferrer',
          class:
            'break-words text-accent-caramel underline decoration-accent-caramel/50 underline-offset-4 hover:text-accent-caramel-light',
        },
        [child],
      )
    }
  }
  return h('span', { key }, [rendered])
}

const renderInlineContent = (value: unknown, keyPrefix: string) =>
  Array.isArray(value)
    ? value.map((inline, index) => renderInline(inline, `${keyPrefix}-inline-${index}`))
    : []

const renderListItem = (item: unknown, key: string): VNodeChild => {
  if (!isRecord(item) || item.type !== 'list_item' || !Array.isArray(item.content)) return null
  return h(
    'li',
    { key, class: 'pl-1' },
    item.content.map((block, index) => renderBlock(block, `${key}-block-${index}`)),
  )
}

const renderBlock = (block: unknown, key: string): VNodeChild => {
  if (!isRecord(block) || typeof block.type !== 'string') return null
  if (block.type === 'paragraph') {
    return h(
      'p',
      { key, class: 'my-4 whitespace-pre-wrap break-words leading-8 text-foreground/90' },
      renderInlineContent(block.content, key),
    )
  }
  if (block.type === 'heading' && (block.level === 2 || block.level === 3)) {
    return h(
      block.level === 2 ? 'h2' : 'h3',
      {
        key,
        class:
          block.level === 2
            ? 'mb-3 mt-9 text-2xl font-bold tracking-tight'
            : 'mb-2 mt-7 text-xl font-bold tracking-tight',
      },
      renderInlineContent(block.content, key),
    )
  }
  if (
    (block.type === 'unordered_list' || block.type === 'ordered_list') &&
    Array.isArray(block.content)
  ) {
    return h(
      block.type === 'unordered_list' ? 'ul' : 'ol',
      {
        key,
        class:
          block.type === 'unordered_list'
            ? 'my-4 list-disc space-y-2 pl-6 leading-8 marker:text-accent-caramel'
            : 'my-4 list-decimal space-y-2 pl-6 leading-8 marker:text-accent-caramel',
      },
      block.content.map((item, index) => renderListItem(item, `${key}-item-${index}`)),
    )
  }
  return null
}

export default defineComponent({
  name: 'AnnouncementRichText',
  props: {
    document: {
      type: Object as PropType<AnnouncementRichTextDocument>,
      required: true,
    },
  },
  setup(props) {
    return () =>
      h(
        'div',
        { class: 'min-w-0 text-base sm:text-lg' },
        isRecord(props.document) &&
          props.document.type === 'document' &&
          Array.isArray(props.document.content)
          ? props.document.content.map((block, index) => renderBlock(block, `block-${index}`))
          : [],
      )
  },
})
</script>
