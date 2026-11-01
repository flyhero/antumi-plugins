import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'
import { pluginPackage } from './plugin-package.mjs'

const { directory, manifest, archive } = await pluginPackage(process.argv[2])
const dist = path.join(directory, 'dist')
const artifact = path.join(dist, 'plugin')
await mkdir(artifact, { recursive: true })
await build({ entryPoints: [path.join(directory, 'src/main.ts')], outfile: path.join(artifact, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' })
const metadata = JSON.stringify(manifest, null, 2) + '\n'
await writeFile(path.join(artifact, 'manifest.json'), metadata)
// Rebuilding identical inputs must preserve the archive checksum.
const bytes = zipSync({ 'manifest.json': strToU8(metadata), 'main.mjs': new Uint8Array(await readFile(path.join(artifact, 'main.mjs'))) }, { mtime: new Date(1980, 0, 1) })
await writeFile(path.join(dist, archive), bytes)
console.log(`Built ${path.relative(process.cwd(), path.join(dist, archive))}`)
