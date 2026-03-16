import { createEngine } from './sync/engine.js'
import type { IndexerConfig, Indexer, IndexerStatus } from './types.js'

export { createMemoryStore } from './store/memory.js'
export { createIdbStore } from './store/idb.js'
export type {
  Store,
  StoreApi,
  StoreFilter,
  CachedEvent,
  Mutation,
  ContractConfig,
  EventHandler,
  EventHandlerContext,
  IndexerConfig,
  IndexerStatus,
  IndexerPhase,
  Indexer,
} from './types.js'

export function createIndexer(config: IndexerConfig): Indexer {
  const engine = createEngine(config)

  return {
    start: () => engine.start(),
    stop: () => engine.stop(),
    reindex: () => engine.reindex(),
    store: engine.storeApi,
    get status() {
      return engine.status
    },
    onStatus(fn: (status: IndexerStatus) => void) {
      return engine.emitter.on('status', fn)
    },
    onChange(fn: (table: string, key: string) => void) {
      return engine.emitter.on('change', ({ table, key }) => fn(table, key))
    },
  }
}
