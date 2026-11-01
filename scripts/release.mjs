import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { releasePackage } from './plugin-package.mjs'

const plugin = await releasePackage(process.argv[2])
const archive = path.join(plugin.directory, 'dist', plugin.archive)
await access(archive)
execFileSync('gh', ['release', 'create', plugin.tag, archive, '--verify-tag', '--title', `${plugin.pkg.name} ${plugin.tag}`, '--notes-file', path.join(plugin.directory, 'CHANGELOG.md'), ...(plugin.prerelease ? ['--prerelease', '--latest=false'] : ['--latest=false'])], { stdio: 'inherit' })
