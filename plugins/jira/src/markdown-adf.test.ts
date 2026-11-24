import { describe, expect, it } from 'vitest'
import { adfToMarkdown } from './jira-adf.js'
import { markdownToAdf } from './markdown-adf.js'

const text = (value: string, ...marks: unknown[]) => ({ type: 'text', text: value, ...(marks.length ? { marks } : {}) })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })

describe('markdownToAdf', () => {
  it('turns paragraphs and line breaks into ADF paragraphs with hard breaks', () => {
    expect(markdownToAdf('第一行\n第二行\\\n第三行  \n\n第二段').content).toEqual([
      paragraph(text('第一行'), { type: 'hardBreak' }, text('第二行'), { type: 'hardBreak' }, text('第三行')),
      paragraph(text('第二段'))
    ])
  })

  it('marks emphasis, code and links, leaving snake_case and lone stars alone', () => {
    const [first] = markdownToAdf('**已修复**：见 [PR #12](https://github.com/a/b/pull/12)，改了 `next_sequence()` 和 snake_case 2 * 3 *斜体*').content
    expect(first).toEqual(
      paragraph(
        text('已修复', { type: 'strong' }),
        text('：见 '),
        text('PR #12', { type: 'link', attrs: { href: 'https://github.com/a/b/pull/12' } }),
        text('，改了 '),
        text('next_sequence()', { type: 'code' }),
        text(' 和 snake_case 2 * 3 '),
        text('斜体', { type: 'em' })
      )
    )
  })

  it('links bare URLs without swallowing trailing punctuation, and refuses unsafe link targets', () => {
    const [first] = markdownToAdf('预览 https://example.com/a?b=1。再看 [这里](javascript:alert(1))').content
    expect(first).toEqual(
      paragraph(text('预览 '), text('https://example.com/a?b=1', { type: 'link', attrs: { href: 'https://example.com/a?b=1' } }), text('。再看 [这里](javascript:alert(1))'))
    )
  })

  it('keeps code marks only alongside links, as ADF requires', () => {
    const [first] = markdownToAdf('**用 `make` 构建**').content
    expect(first).toEqual(paragraph(text('用 ', { type: 'strong' }), text('make', { type: 'code' }), text(' 构建', { type: 'strong' })))
  })

  it('builds headings, nested lists, ordered lists, quotes and fenced code', () => {
    const doc = markdownToAdf(['## 结果', '修改如下：', '- 一', '  - 一点一', '- 二', '', '3. 三', '4. 四', '', '> ## 注意', '> 引用', '', '```ts', 'const a = 1 < 2', '```', '', '---'].join('\n'))
    expect(doc.content.map((block) => block.type)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule'])
    expect(doc.content[2]).toEqual({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(text('一')), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('一点一'))] }] }] },
        { type: 'listItem', content: [paragraph(text('二'))] }
      ]
    })
    expect(doc.content[3]).toMatchObject({ type: 'orderedList', attrs: { order: 3 } })
    expect(doc.content[4]).toEqual({ type: 'blockquote', content: [paragraph(text('注意', { type: 'strong' })), paragraph(text('引用'))] })
    expect(doc.content[5]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1 < 2')] })
  })

  it('keeps one list across blank lines between items', () => {
    const doc = markdownToAdf('- a\n\n- b\n\n后文')
    expect(doc.content.map((block) => block.type)).toEqual(['bulletList', 'paragraph'])
    expect(doc.content[0]).toMatchObject({ content: [{ type: 'listItem' }, { type: 'listItem' }] })
  })

  it('reads back as the Markdown it came from', () => {
    const markdown = '## 总结\n\n已修复 **重复下单**，见 [PR](https://example.com/pr/1)。\n\n- 改了 `OrderService`\n- 补了测试\n\n```\nnpm test\n```'
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown)
  })

  it('stays bounded on hostile nesting', () => {
    const deep = `${'> '.repeat(5000)}x\n${'- '.repeat(3000)}y\n${'**'.repeat(4000)}`
    expect(() => JSON.stringify(markdownToAdf(deep))).not.toThrow()
  })
})
