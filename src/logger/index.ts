import { createNodeLogger, logStartupNode } from './node.js'
import { createBrowserLogger, logStartupBrowser } from './browser.js'
import type { IndexerConfig, IndexerLogger } from '../types.js'

type Env = 'node' | 'browser'

function detectEnv(): Env {
  if (
    typeof window !== 'undefined' &&
    typeof window.document !== 'undefined'
  ) {
    return 'browser'
  }
  return 'node'
}

export function createLogger(
  name: string,
  env?: Env,
): Required<IndexerLogger> {
  const e = env ?? detectEnv()
  if (e === 'browser') return createBrowserLogger(name)
  return createNodeLogger(name)
}

export function logStartup(
  name: string,
  config: IndexerConfig,
  env?: Env,
) {
  const e = env ?? detectEnv()
  if (e === 'browser') logStartupBrowser(name, config)
  else logStartupNode(name, config)
}
