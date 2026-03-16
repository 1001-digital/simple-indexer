import { backfill } from './backfill.js'
import { startLiveSync } from './live.js'
import { Emitter } from '../utils/emitter.js'
import type {
  Store,
  StoreApi,
  CachedEvent,
  IndexerConfig,
  IndexerStatus,
} from '../types.js'

type EngineEvents = {
  status: IndexerStatus
  change: { table: string; key: string }
}

function createStoreApi(
  store: Store,
  blockRef: { current: bigint },
  onChange: (table: string, key: string) => void,
): StoreApi {
  return {
    get: (table, key) => store.get(table, key),
    getAll: (table, filter?) => store.getAll(table, filter),

    async set(table, key, value) {
      const previous = await store.get(table, key)
      await store.recordMutation({
        block: blockRef.current,
        table,
        key,
        op: 'set',
        previous: previous ? { ...previous } : undefined,
      })
      await store.set(table, key, value)
      onChange(table, key)
    },

    async update(table, key, partial) {
      const previous = await store.get(table, key)
      await store.recordMutation({
        block: blockRef.current,
        table,
        key,
        op: 'update',
        previous: previous ? { ...previous } : undefined,
      })
      await store.update(table, key, partial)
      onChange(table, key)
    },

    async delete(table, key) {
      const previous = await store.get(table, key)
      await store.recordMutation({
        block: blockRef.current,
        table,
        key,
        op: 'delete',
        previous: previous ? { ...previous } : undefined,
      })
      await store.delete(table, key)
      onChange(table, key)
    },
  }
}

export function createEngine(config: IndexerConfig) {
  const {
    client,
    store,
    contracts,
    version = 1,
    pollingInterval = 12_000,
    finalityDepth = 2,
    chunkSize = 2000,
  } = config

  const emitter = new Emitter<EngineEvents>()
  const blockRef = { current: 0n }
  let stopLive: (() => void) | undefined
  let stopped = false

  const storeApi = createStoreApi(store, blockRef, (table, key) => {
    emitter.emit('change', { table, key })
  })

  const status: IndexerStatus = {
    phase: 'idle',
    currentBlock: 0n,
    latestBlock: 0n,
    progress: 0,
  }

  function updateStatus(update: Partial<IndexerStatus>) {
    Object.assign(status, update)
    emitter.emit('status', { ...status })
  }

  async function processEvents(events: CachedEvent[]) {
    for (const event of events) {
      const contract = contracts[event.contractName]
      if (!contract) continue
      const handler = contract.events[event.eventName]
      if (!handler) continue

      blockRef.current = event.block
      await handler({
        event: {
          name: event.eventName,
          args: event.args,
          address: event.address,
          block: event.block,
          logIndex: event.logIndex,
          transactionHash: event.transactionHash,
          blockHash: event.blockHash,
        },
        store: storeApi,
      })
    }
  }

  function startLivePolling() {
    return startLiveSync({
      client,
      store,
      contracts,
      processEvents,
      finalityDepth,
      chunkSize,
      pollingInterval,
      onNewBlock: (block, head) => {
        updateStatus({ currentBlock: block, latestBlock: head })
      },
      onReorg: (fromBlock) => {
        updateStatus({ phase: 'live', currentBlock: fromBlock - 1n })
      },
      onError: (error) => {
        updateStatus({ phase: 'error', error })
      },
    })
  }

  async function start() {
    stopped = false

    // Version check — trigger reindex if handler logic changed
    const storedVersion = await store.getVersion()
    if (storedVersion !== undefined && storedVersion !== version) {
      await reindex()
    }
    await store.setVersion(version)

    // Get global cursor
    const cursor = await store.getCursor('_indexer')

    // Clean up any partial writes from a prior crash
    if (cursor !== undefined) {
      await store.rollback(cursor + 1n)
      await store.removeEventsFrom(cursor + 1n)
      await store.removeBlockHashesFrom(cursor + 1n)
    }

    // Determine starting block
    const minStartBlock =
      Object.values(contracts).reduce(
        (min, c) => {
          if (c.startBlock === undefined) return min
          return min === undefined || c.startBlock < min ? c.startBlock : min
        },
        undefined as bigint | undefined,
      ) ?? 0n

    const startFrom = cursor !== undefined ? cursor + 1n : minStartBlock

    // Get chain head
    const head = await client.getBlockNumber()
    const target = head - BigInt(finalityDepth)

    if (startFrom <= target) {
      updateStatus({ phase: 'backfilling', latestBlock: head })
      const totalBlocks = Number(target - startFrom)

      await backfill({
        client,
        store,
        contracts,
        from: startFrom,
        to: target,
        chunkSize,
        processEvents,
        onProgress: (currentBlock) => {
          const progress =
            totalBlocks > 0 ? Number(currentBlock - startFrom) / totalBlocks : 1
          updateStatus({ currentBlock, progress })
        },
        shouldStop: () => stopped,
      })
    }

    if (stopped) return

    // Transition to live sync
    updateStatus({
      phase: 'live',
      progress: 1,
      currentBlock: target,
      latestBlock: head,
    })
    stopLive = startLivePolling()
  }

  function stop() {
    stopped = true
    stopLive?.()
    stopLive = undefined
    updateStatus({ phase: 'idle' })
  }

  async function reindex() {
    const wasLive = status.phase === 'live'
    if (wasLive) {
      stopLive?.()
      stopLive = undefined
    }

    updateStatus({ phase: 'reindexing' })

    // Clear derived state (user tables + mutation log) but keep event cache
    await store.clearDerivedState()

    // Replay all cached events through current handlers
    const events = await store.getEvents()
    await processEvents(events)

    await store.setVersion(version)

    if (wasLive && !stopped) {
      updateStatus({ phase: 'live', progress: 1 })
      stopLive = startLivePolling()
    } else {
      updateStatus({ phase: 'idle' })
    }
  }

  return { start, stop, reindex, storeApi, status, emitter }
}
