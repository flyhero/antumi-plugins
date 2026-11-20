import { describe, expect, it } from 'vitest'
import { githubImages } from './github-images.js'

const base = 'https://github.com/acme/widgets/issues/7'
const asset = 'https://github.com/user-attachments/assets/abc'

describe('GitHub image references', () => {
  it('reads inline, reference-style and HTML images while ignoring code examples and ordinary links', () => {
    const markdown = [
      `![Screenshot](${asset} "title")`,
      '![same][shot]',
      `[shot]: ${asset}`,
      '<img alt="A &amp; B" src="https://user-images.githubusercontent.com/1/a.png?x=1&amp;y=2">',
      '![parentheses](https://raw.githubusercontent.com/a/b/main/a(b).png)',
      '`![example](https://example.com/code.png)`',
      '```md\n![example](https://example.com/block.png)\n```',
      '[ordinary link](https://example.com/page)'
    ].join('\n\n')
    const images = githubImages(markdown, base)
    expect(images.map((image) => [image.name, image.url])).toEqual([
      ['Screenshot', asset],
      ['A & B', 'https://user-images.githubusercontent.com/1/a.png?x=1&y=2'],
      ['parentheses', 'https://raw.githubusercontent.com/a/b/main/a(b).png']
    ])
  })

  it('uses rendered image addresses but keeps identities across expiring signed URLs', () => {
    const raw = `![private](${asset})`
    const first = githubImages(raw, base, '<img src="https://private-user-images.githubusercontent.com/1/a.png?jwt=old">')
    const next = githubImages(raw, base, '<img src="https://private-user-images.githubusercontent.com/1/a.png?jwt=new">')
    expect(first[0]?.id).toBe(next[0]?.id)
    expect(first[0]?.id).toBe(githubImages(raw, base)[0]?.id)
    expect(next[0]?.url).toContain('jwt=new')
    expect(githubImages(raw, base, '<p>No rendered image</p>')).toEqual([])
  })

  it('uses canonical links from GitHub proxy images and limits reference counts and names', () => {
    const html = `<img src="https://camo.githubusercontent.com/proxy" data-canonical-src="${asset}" alt="${'x'.repeat(200)}">`
    expect(githubImages('', base, html)[0]?.id).toBe(githubImages(`![](${asset})`, base)[0]?.id)
    expect(githubImages('', base, html)[0]?.name).toHaveLength(120)
    expect(githubImages(Array.from({ length: 120 }, (_, i) => `![${i}](${asset}${i})`).join('\n'), base)).toHaveLength(100)
  })

  it('ignores embedded data, unsafe schemes, embedded credentials and unusual ports', () => {
    expect(githubImages('![](data:image/png;base64,abc) ![](http://localhost/a.png) ![](https://user:secret@github.com/a.png) ![](https://github.com:8443/a.png)', base)).toEqual([])
  })
})
