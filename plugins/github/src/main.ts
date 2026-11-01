import { runSourcePlugin } from '@antumi/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { githubProvider } from './github-provider.js'

runSourcePlugin({ manifest, sources: [githubProvider()] })
