import { runSourcePlugin } from '@antumi/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { meegleSource } from './meegle-source.js'

runSourcePlugin({ manifest, sources: [meegleSource()] })
