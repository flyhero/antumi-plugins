import { runSourcePlugin } from '@antumi/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { tapdSource } from './tapd-source.js'

runSourcePlugin({ manifest, sources: [tapdSource()] })
