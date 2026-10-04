import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAnnouncementRichText } from '../dist/utils/announcementRichText.js'

const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const paragraph = (...content) => ({ type: 'paragraph', content })
const document = (...content) => ({ type: 'document', content })

describe('P10-I1 Announcement Rich Text contract', () => {
  it('accepts every supported block, inline, and mark structure', () => {
    const body = document(
      paragraph(
        text('Paragraph ', [{ type: 'bold' }]),
        {
          type: 'line_break',
        },
        text('with link', [{ type: 'link', href: 'https://movune.example/news' }]),
      ),
      { type: 'heading', level: 2, content: [text('H2')] },
      { type: 'heading', level: 3, content: [text('H3')] },
      {
        type: 'unordered_list',
        content: [{ type: 'list_item', content: [paragraph(text('First'))] }],
      },
      {
        type: 'ordered_list',
        content: [{ type: 'list_item', content: [paragraph(text('Second'))] }],
      },
      paragraph(text('Internal', [{ type: 'link', href: '/announcements' }])),
    )

    assert.equal(isAnnouncementRichText(body), true)
  })

  it('rejects unsupported headings, media, embeds, HTML, and unknown nodes', () => {
    for (const invalid of [
      document({ type: 'heading', level: 1, content: [text('H1')] }),
      document({ type: 'heading', level: 4, content: [text('H4')] }),
      document({ type: 'image', src: 'https://example.com/image.png' }),
      document({ type: 'iframe', src: 'https://example.com' }),
      document({ type: 'raw_html', html: '<script>alert(1)</script>' }),
      document({ type: 'table', content: [] }),
      document({ type: 'custom_node', content: [] }),
    ]) {
      assert.equal(isAnnouncementRichText(invalid), false)
    }
  })

  it('rejects unknown marks, attributes, executable links, and malformed links', () => {
    for (const invalid of [
      document(paragraph(text('bad', [{ type: 'italic' }]))),
      document(paragraph(text('bad', [{ type: 'bold', color: 'red' }]))),
      document(paragraph(text('bad', [{ type: 'link', href: 'javascript:alert(1)' }]))),
      document(paragraph(text('bad', [{ type: 'link', href: 'not a url' }]))),
      document(paragraph(text('bad', [{ type: 'link', href: '//evil.example' }]))),
      document(
        paragraph(text('bad', [{ type: 'link', href: 'https://example.com', target: '_blank' }])),
      ),
      document({ type: 'paragraph', content: [text('bad')], color: 'red' }),
    ]) {
      assert.equal(isAnnouncementRichText(invalid), false)
    }
  })

  it('rejects malformed nesting at every structural level', () => {
    for (const invalid of [
      { type: 'document', content: [] },
      document(text('text cannot be a root block')),
      document({ type: 'unordered_list', content: [paragraph(text('not an item'))] }),
      document({ type: 'ordered_list', content: [{ type: 'list_item', content: [] }] }),
      document({ type: 'heading', level: 2, content: [paragraph(text('nested block'))] }),
      document(paragraph({ type: 'list_item', content: [paragraph(text('nested item'))] })),
    ]) {
      assert.equal(isAnnouncementRichText(invalid), false)
    }
  })
})
