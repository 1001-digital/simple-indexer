import type { Dapp, Indexer } from '../types.js'

export interface LocalDappConfig {
  indexer: Indexer
}

export function createLocalDapp(config: LocalDappConfig): Dapp {
  const { indexer } = config

  return {
    get(table, key) {
      return indexer.store.get(table, key)
    },

    getAll(table, filter?) {
      return indexer.store.getAll(table, filter)
    },

    subscribe(fn) {
      return indexer.onChange(fn)
    },
  }
}
