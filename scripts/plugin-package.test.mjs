import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginPackage, releasePackage } from './plugin-package.mjs'

test('resolves independent plugin versions and matching release tags', async () => {
  for (const slug of ['github', 'jira', 'linear', 'zentao']) {
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
