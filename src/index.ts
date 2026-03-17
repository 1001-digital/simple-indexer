import { createEngine } from './sync/engine.js'
import { createLogger, logStartup } from './logger.js'
import type { IndexerConfig, Indexer, IndexerStatus, IndexerLogger, ChunkInfo } from './types.js'

export { createMemoryStore } from './store/memory.js'
export { createIdbStore } from './store/idb.js'
export type {
  Store,
  StoreApi,
  StoreFilter,
  CachedEvent,
  CachedReceipt,
  CachedReceiptLog,
  Mutation,
  ContractConfig,
  EventHandler,
  EventHandlerContext,
  IndexerConfig,
  IndexerLogger,
  LogOption,
  IndexerStatus,
  IndexerPhase,
  ChunkInfo,
  Indexer,
} from './types.js'

// Query layer
export {
  indexer,
  rpc,
  fallback,
  createView,
  SourceMiss,
  http,
  createHttpHandler,
} from './query/index.js'
export type {
  EventFilter,
  SourceEvent,
  SourceResult,
  Source,
  View,
  ViewConfig,
  IndexerSourceConfig,
  RpcSourceConfig,
  FallbackConfig,
  HttpSourceConfig,
  HttpHandlerConfig,
} from './query/index.js'

export function createIndexer(config: IndexerConfig): Indexer {
  const engine = createEngine(config)

  // --- Built-in logger ---
  const logOption = config.log ?? true
  if (logOption !== false) {
    const name = config.name ?? Object.keys(config.contracts)[0] ?? 'indexer'
    const logger: Required<IndexerLogger> =
      logOption === true
        ? createLogger(name)
        : {
            onStatus: logOption.onStatus ?? (() => {}),
            onChunk: logOption.onChunk ?? (() => {}),
            onError: logOption.onError ?? (() => {}),
          }

    if (logOption === true) {
      logStartup(name, config)
    }

    engine.emitter.on('status', (status) => {
      logger.onStatus(status)
      if (status.error) logger.onError(status.error)
    })
    engine.emitter.on('chunk', logger.onChunk)
  }

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
    onChunk(fn: (chunk: ChunkInfo) => void) {
      return engine.emitter.on('chunk', fn)
    },
  }
}
