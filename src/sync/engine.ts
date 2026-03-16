import { backfill } from './backfill.js'
import { startLiveSync } from './live.js'
import { Emitter } from '../utils/emitter.js'
import type {
  Store,
  StoreApi,
  CachedEvent,
  ChunkInfo,
  IndexerConfig,
  IndexerStatus,
} from '../types.js'

type EngineEvents = {
  status: IndexerStatus
  change: { table: string; key: string }
  chunk: ChunkInfo
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
    startBlock: 0n,
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
      onChunk: (chunk) => {
        emitter.emit('chunk', { phase: 'live', ...chunk })
      },
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

    // Get global cursor and event cache watermark
    const cursor = await store.getCursor('_indexer')
    const eventsWatermark = await store.getCursor('_events_watermark')

    // Roll back derived state from any incomplete chunk, but preserve
    // cached events and block hashes so backfill can replay from cache.
    if (cursor !== undefined) {
      await store.rollback(cursor + 1n)
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
    let target = head - BigInt(finalityDepth)

    // If all contracts have an endBlock, cap the target
    const contractList = Object.values(contracts)
    const allHaveEndBlock =
      contractList.length > 0 && contractList.every((c) => c.endBlock !== undefined)
    const maxEndBlock = allHaveEndBlock
      ? contractList.reduce((max, c) => (c.endBlock! > max ? c.endBlock! : max), 0n)
      : undefined

    if (maxEndBlock !== undefined && maxEndBlock < target) {
      target = maxEndBlock
    }

    if (startFrom <= target) {
      const cachedBlocks =
        cursor !== undefined ? Number(cursor - minStartBlock + 1n) : undefined
      const totalBlocks = Number(target - minStartBlock)
      updateStatus({
        phase: 'backfilling',
        startBlock: minStartBlock,
        currentBlock: startFrom,
        latestBlock: head,
        progress:
          totalBlocks > 0 ? Number(startFrom - minStartBlock) / totalBlocks : 0,
        cachedBlocks: cachedBlocks && cachedBlocks > 0 ? cachedBlocks : undefined,
      })

      await backfill({
        client,
        store,
        contracts,
        from: startFrom,
        to: target,
        chunkSize,
        cachedUpTo: eventsWatermark,
        processEvents,
        onChunk: (chunk) => {
          emitter.emit('chunk', { phase: 'backfill', ...chunk })
        },
        onProgress: (currentBlock) => {
          const progress =
            totalBlocks > 0
              ? Number(currentBlock - minStartBlock) / totalBlocks
              : 1
          updateStatus({ currentBlock, progress })
        },
        shouldStop: () => stopped,
      })
    }

    if (stopped) return

    // Skip live sync if all contracts have a defined end block
    if (maxEndBlock !== undefined) {
      updateStatus({
        phase: 'idle',
        progress: 1,
        currentBlock: target,
        latestBlock: head,
      })
      return
    }

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
