import type { Dapp, Indexer } from '../types.js'
import { createLocalDapp } from './local.js'
import { createRemoteDapp } from './remote.js'

export type DappConfig =
  | { indexer: Indexer; url?: never }
  | { url: string; indexer?: never; fetch?: typeof globalThis.fetch; EventSource?: typeof globalThis.EventSource }

export function createDapp(config: DappConfig): Dapp {
  if ('indexer' in config && config.indexer) {
    return createLocalDapp({ indexer: config.indexer })
  }
  return createRemoteDapp({
    url: config.url,
    fetch: config.fetch,
    EventSource: config.EventSource,
  })
}

export { createStoreHandler } from './handler.js'
export type { StoreHandlerConfig } from './handler.js'
export type { DappConfig as CreateDappConfig }
