import { runSourcePlugin } from '@antumi/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { linearSource } from './linear-source.js'

runSourcePlugin({ manifest, sources: [linearSource()] })
