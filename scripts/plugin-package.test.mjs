import { test } from 'node:test'
import assert from 'node:assert/strict'
import { droppedFields, pluginPackage, releasePackage } from './plugin-package.mjs'

test('resolves independent plugin versions and matching release tags', async () => {
  for (const slug of ['github', 'jira', 'linear', 'zentao', 'meegle', 'tapd']) {
    const plugin = await pluginPackage(slug)
    const release = await releasePackage(`${slug}-v${plugin.pkg.version}`)
    assert.equal(release.manifest.id, `antumi.${slug}`)
    assert.equal(release.archive, `${plugin.pkg.name}-${plugin.pkg.version}.zip`)
    assert.equal(release.prerelease, false)
  }
})

test('rejects traversal, unknown plugins, unscoped tags and mismatched versions', async () => {
  for (const slug of ['../github', '/github', 'missing', '', undefined]) await assert.rejects(pluginPackage(slug))
  for (const tag of ['v1.0.0', 'github-v999.0.0', 'jira-v1.0.0-beta.1', '../github-v1.0.1']) await assert.rejects(releasePackage(tag))
})

test('keeps every manifest field, writeback included, in what is packaged', async () => {
  for (const slug of ['github', 'jira', 'linear', 'zentao', 'meegle', 'tapd']) {
    const { manifest } = await pluginPackage(slug)
    assert.equal(manifest.contributes.sources[0].writeback, 1, slug)
  }
  assert.equal((await pluginPackage('zentao')).manifest.contributes.sources[0].writebackComment, false)
  assert.deepEqual(droppedFields({ a: 1, b: { c: [{ d: 1, e: 2 }] } }, { a: 1, b: { c: [{ d: 1 }] } }), ['b.c[0].e'])
})
