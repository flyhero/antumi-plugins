import { runSourcePlugin } from '@antumi/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { zentaoSource } from './zentao-source.js'

runSourcePlugin({ manifest, sources: [zentaoSource()] })
