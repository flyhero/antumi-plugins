import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginManifest } from '@antumi/plugin-sdk'

export const root = fileURLToPath(new URL('../', import.meta.url))

export async function pluginPackage(slug) {
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('Expected a plugin slug')
  const directory = path.join(root, 'plugins', slug)
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  const manifest = PluginManifest.parse(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')))
  if (pkg.version !== manifest.version) throw new Error('Package and manifest versions must match')
  if (!/^[a-z][a-z0-9-]*$/.test(pkg.name)) throw new Error('Package name must be a safe ZIP filename')
  if (manifest.entry.main !== 'main.mjs') throw new Error('Expected main.mjs entry')
  return { directory, pkg, manifest, archive: `${pkg.name}-${pkg.version}.zip` }
}

export async function releasePackage(tag) {
  const match = /^([a-z][a-z0-9-]*)-v(.+)$/.exec(tag ?? '')
  if (!match) throw new Error('Expected <plugin>-v<version> release tag')
  const plugin = await pluginPackage(match[1])
  if (match[2] !== plugin.pkg.version) throw new Error('Release tag, package and manifest versions must match')
  return { ...plugin, tag, prerelease: plugin.pkg.version.includes('-') }
}
