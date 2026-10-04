export type AnnouncementRichTextMark =
  Readonly<{ type: 'bold' }> | Readonly<{ type: 'link'; href: string }>

export type AnnouncementRichTextInline =
  | Readonly<{
      type: 'text'
      text: string
      marks?: readonly AnnouncementRichTextMark[]
    }>
  | Readonly<{ type: 'line_break' }>

export type AnnouncementRichTextBlock =
  | Readonly<{
      type: 'paragraph'
      content: readonly AnnouncementRichTextInline[]
    }>
  | Readonly<{
      type: 'heading'
      level: 2 | 3
      content: readonly AnnouncementRichTextInline[]
    }>
  | Readonly<{
      type: 'unordered_list' | 'ordered_list'
      content: readonly AnnouncementRichTextListItem[]
    }>

export type AnnouncementRichTextListItem = Readonly<{
  type: 'list_item'
  content: readonly AnnouncementRichTextBlock[]
}>

export type AnnouncementRichTextDocument = Readonly<{
  type: 'document'
  content: readonly AnnouncementRichTextBlock[]
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

const isSafeHref = (href: unknown): href is string => {
  if (typeof href !== 'string' || href.length === 0 || href !== href.trim()) return false

  if (href.startsWith('/')) return !href.startsWith('//')

  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

const isMark = (value: unknown): value is AnnouncementRichTextMark => {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'bold') return hasExactlyKeys(value, ['type'])
  if (value.type === 'link') {
    return hasExactlyKeys(value, ['type', 'href']) && isSafeHref(value.href)
  }
  return false
}

const isInline = (value: unknown): value is AnnouncementRichTextInline => {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'line_break') return hasExactlyKeys(value, ['type'])
  if (value.type !== 'text') return false

  const keys = value.marks === undefined ? ['type', 'text'] : ['type', 'text', 'marks']
  return (
    hasExactlyKeys(value, keys) &&
    typeof value.text === 'string' &&
    (value.marks === undefined ||
      (Array.isArray(value.marks) && value.marks.length > 0 && value.marks.every(isMark)))
  )
}

const isListItem = (value: unknown): value is AnnouncementRichTextListItem =>
  isRecord(value) &&
  value.type === 'list_item' &&
  hasExactlyKeys(value, ['type', 'content']) &&
  Array.isArray(value.content) &&
  value.content.length > 0 &&
  value.content.every(isBlock)

const isBlock = (value: unknown): value is AnnouncementRichTextBlock => {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  if (value.type === 'paragraph') {
    return (
      hasExactlyKeys(value, ['type', 'content']) &&
      Array.isArray(value.content) &&
      value.content.every(isInline)
    )
  }

  if (value.type === 'heading') {
    return (
      hasExactlyKeys(value, ['type', 'level', 'content']) &&
      (value.level === 2 || value.level === 3) &&
      Array.isArray(value.content) &&
      value.content.length > 0 &&
      value.content.every(isInline)
    )
  }

  if (value.type === 'unordered_list' || value.type === 'ordered_list') {
    return (
      hasExactlyKeys(value, ['type', 'content']) &&
      Array.isArray(value.content) &&
      value.content.length > 0 &&
      value.content.every(isListItem)
    )
  }

  return false
}

export const isAnnouncementRichText = (value: unknown): value is AnnouncementRichTextDocument =>
  isRecord(value) &&
  value.type === 'document' &&
  hasExactlyKeys(value, ['type', 'content']) &&
  Array.isArray(value.content) &&
  value.content.length > 0 &&
  value.content.every(isBlock)
