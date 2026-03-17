import { backfill } from './backfill.js'
import { startLiveSync } from './live.js'
import { Emitter } from '../utils/emitter.js'
import { getEventHandler, getEventArgs } from '../types.js'
import {
  computeSchemaFingerprint,
  normalizeSchema,
} from '../store/indexing.js'
import type {
  Store,
  StoreApi,
  CachedEvent,
  ChunkInfo,
  ContractConfig,
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
  eventRef: { block: bigint; logIndex: number },
  onChange: (table: string, key: string) => void,
): StoreApi {
  return {
    get: (table, key) => store.get(table, key),
    getAll: (table, filter?) => store.getAll(table, filter),

    async set(table, key, value) {
      const entry = await store.getEntry(table, key)
      await store.recordMutation({
        block: eventRef.block,
        table,
        key,
        op: 'set',
        previous: entry ? { ...entry.value } : undefined,
        previousBlock: entry?.block,
        previousLogIndex: entry?.logIndex,
      })
      await store.set(table, key, value, eventRef.block, eventRef.logIndex)
      onChange(table, key)
    },

    async update(table, key, partial) {
      const entry = await store.getEntry(table, key)
      await store.recordMutation({
        block: eventRef.block,
        table,
        key,
        op: 'update',
        previous: entry ? { ...entry.value } : undefined,
        previousBlock: entry?.block,
        previousLogIndex: entry?.logIndex,
      })
      await store.update(table, key, partial, eventRef.block, eventRef.logIndex)
      onChange(table, key)
    },

    async delete(table, key) {
      const entry = await store.getEntry(table, key)
      await store.recordMutation({
        block: eventRef.block,
        table,
        key,
        op: 'delete',
        previous: entry ? { ...entry.value } : undefined,
        previousBlock: entry?.block,
        previousLogIndex: entry?.logIndex,
      })
      await store.delete(table, key)
      onChange(table, key)
    },
  }
}

function computeEventFingerprint(
  contracts: Record<string, ContractConfig>,
): string {
  const keys: string[] = []
  for (const [name, contract] of Object.entries(contracts)) {
    for (const eventName of Object.keys(contract.events)) {
      keys.push(`${name}:${eventName}`)
    }
  }
  return keys.sort().join(',')
}

async function readEventWatermarks(
  store: Store,
  contracts: Record<string, ContractConfig>,
): Promise<Map<string, bigint>> {
  const watermarks = new Map<string, bigint>()
  for (const [name, contract] of Object.entries(contracts)) {
    for (const eventName of Object.keys(contract.events)) {
      const wm = await store.getCursor(`_ew:${name}:${eventName}`)
      if (wm !== undefined) watermarks.set(`${name}:${eventName}`, wm)
    }
  }
  return watermarks
}

export function createEngine(config: IndexerConfig) {
  const {
    client,
    store,
    contracts,
    schema,
    version = 1,
    pollingInterval = 12_000,
    finalityDepth = 0,
    maxChunkSize = 2000,
  } = config

  const emitter = new Emitter<EngineEvents>()
  const eventRef = { block: 0n, logIndex: 0 }
  let stopLive: (() => void) | undefined
  let stopped = false
  const normalizedSchema = normalizeSchema(schema)
  const schemaFingerprint = computeSchemaFingerprint(normalizedSchema)

  const storeApi = createStoreApi(store, eventRef, (table, key) => {
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
      const eventConfig = contract.events[event.eventName]
      if (!eventConfig) continue
      const handler = getEventHandler(eventConfig)

      // Skip events that don't match the configured args filter (e.g. cached
      // events fetched before an args filter was added)
      const argsFilter = getEventArgs(eventConfig)
      if (argsFilter) {
        const mismatch = Object.entries(argsFilter).some(
          ([key, val]) => event.args[key] !== val,
        )
        if (mismatch) continue
      }

      eventRef.block = event.block
      eventRef.logIndex = event.logIndex

      await handler({
        event: {
          name: event.eventName,
          args: event.args,
          address: event.address,
          block: event.block,
          logIndex: event.logIndex,
          transactionHash: event.transactionHash,
          blockHash: event.blockHash,
          receipt: event.receipt,
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
      maxChunkSize,
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
    await store.configureSchema?.(normalizedSchema)

    const storedVersion = await store.getVersion()
    const storedFingerprint = await store.getEventFingerprint()
    const storedSchemaFingerprint = await store.getSchemaFingerprint?.()
    const currentFingerprint = computeEventFingerprint(contracts)

    const isFirstRun = storedVersion === undefined
    const versionChanged = !isFirstRun && storedVersion !== version
    const fingerprintKnown = storedFingerprint !== undefined
    const eventsChanged = fingerprintKnown && storedFingerprint !== currentFingerprint
    const schemaChanged =
      storedSchemaFingerprint !== undefined &&
      storedSchemaFingerprint !== schemaFingerprint
    let didReplay = false

    if (!isFirstRun && (versionChanged || eventsChanged || schemaChanged)) {
      if (versionChanged && !fingerprintKnown) {
        // Upgrading from an older version without fingerprint tracking —
        // can't determine which events are cached, full reset is safest.
        await store.clearDerivedState()
        await store.removeEventsFrom(0n)
        await store.removeBlockHashesFrom(0n)
        await store.deleteCursor('_indexer')
      } else if (eventsChanged) {
        // Events changed — clear derived state and reset cursor.
        // Backfill handles mixed cached/uncached chunks via per-event watermarks:
        // existing events replay from cache, new events are fetched from RPC.
        await store.clearDerivedState()
        await store.deleteCursor('_indexer')
      } else {
        // Version or schema changed, same events — replay from cache
        await store.clearDerivedState()
        const allEvents = await store.getEvents()
        await processEvents(allEvents)
        const watermarks = await readEventWatermarks(store, contracts)
        const maxWm = watermarks.size > 0
          ? [...watermarks.values()].reduce((a, b) => (a > b ? a : b))
          : undefined
        if (maxWm !== undefined) {
          await store.setCursor('_indexer', maxWm)
        }
        didReplay = true
      }
    }

    await store.setVersion(version)
    await store.setEventFingerprint(currentFingerprint)
    await store.setSchemaFingerprint?.(schemaFingerprint)

    const eventWatermarks = await readEventWatermarks(store, contracts)
    const cursor = await store.getCursor('_indexer')

    // Roll back derived state from any incomplete chunk, but preserve
    // cached events and block hashes so backfill can replay from cache.
    // Skip if we just did a full replay above.
    if (!didReplay && cursor !== undefined) {
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
        maxChunkSize,
        eventWatermarks,
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
    await store.setSchemaFingerprint?.(schemaFingerprint)

    if (wasLive && !stopped) {
      updateStatus({ phase: 'live', progress: 1 })
      stopLive = startLivePolling()
    } else {
      updateStatus({ phase: 'idle' })
    }
  }

  return { start, stop, reindex, storeApi, status, emitter }
}
