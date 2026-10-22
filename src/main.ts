import { runSourcePlugin } from '@antumi/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { jiraProvider } from './jira-provider.js'

runSourcePlugin({ manifest, sources: [jiraProvider()] })
