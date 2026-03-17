import { backfill, fetchContractEvents, fetchAndCacheReceipts } from './backfill.js'
import { startLiveSync } from './live.js'
import { forEachAdaptiveRange } from '../utils/adaptive-ranges.js'
import { Emitter } from '../utils/emitter.js'
import { getEventHandler, getEventArgs } from '../types.js'
import type { PublicClient } from 'viem'
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

function getAddedEventKeys(oldFp: string, newFp: string): string[] {
  const oldKeys = new Set(oldFp.split(',').filter(Boolean))
  return newFp
    .split(',')
    .filter(Boolean)
    .filter((k) => !oldKeys.has(k))
}

/**
 * Fetch events for newly-added event keys over the already-cached block range.
 * Existing cached events are untouched; only the new events are appended.
 */
async function fillNewEvents(
  client: PublicClient,
  store: Store,
  contracts: Record<string, ContractConfig>,
  addedKeys: string[],
  watermark: bigint,
  maxChunkSize: number,
  onChunk?: (chunk: { from: bigint; to: bigint; size: number; eventCount: number }) => void,
) {
  // Group added events by contract name
  const byContract = new Map<string, Set<string>>()
  for (const key of addedKeys) {
    const sep = key.indexOf(':')
    const contractName = key.slice(0, sep)
    const eventName = key.slice(sep + 1)
    if (!byContract.has(contractName)) byContract.set(contractName, new Set())
    byContract.get(contractName)!.add(eventName)
  }

  for (const [contractName, eventNames] of byContract) {
    const contract = contracts[contractName]
    if (!contract) continue

    const contractStart = contract.startBlock ?? 0n
    if (contractStart > watermark) continue

    // Build a contract config that only matches the new events
    const filteredEvents: Record<string, (typeof contract.events)[string]> = {}
    for (const name of eventNames) {
      if (contract.events[name]) filteredEvents[name] = contract.events[name]
    }
    const filteredContract: ContractConfig = { ...contract, events: filteredEvents }

    // Resume from per-event cursor if a previous gap-fill was interrupted
    const cursorKey = `_gap:${contractName}:${[...eventNames].sort().join(',')}`
    const savedCursor = await store.getCursor(cursorKey)
    const from = savedCursor !== undefined ? savedCursor + 1n : contractStart

    if (from > watermark) continue

    await forEachAdaptiveRange<CachedEvent[]>({
      from,
      to: watermark,
      maxChunkSize,
      fetch: async (chunkFrom, chunkTo) => {
        return fetchContractEvents(
          client,
          contractName,
          filteredContract,
          chunkFrom,
          chunkTo,
        )
      },
      onChunk: async ({ from: chunkFrom, to: chunkTo, value: events }) => {
        if (events.length > 0) {
          await store.appendEvents(events)
          await fetchAndCacheReceipts(client, store, contracts, events)
        }
        await store.setCursor(cursorKey, chunkTo)
        onChunk?.({
          from: chunkFrom,
          to: chunkTo,
          size: Number(chunkTo - chunkFrom + 1n),
          eventCount: events.length,
        })
      },
    })

    // Gap-fill complete for this key — clean up the cursor
    await store.deleteCursor(cursorKey)
  }
}

export function createEngine(config: IndexerConfig) {
  const {
    client,
    store,
    contracts,
    version = 1,
    pollingInterval = 12_000,
    finalityDepth = 0,
    maxChunkSize = 2000,
  } = config

  const emitter = new Emitter<EngineEvents>()
  const eventRef = { block: 0n, logIndex: 0 }
  let stopLive: (() => void) | undefined
  let stopped = false

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

      const receipt = contract.includeTransactionReceipts
        ? await store.getReceipt(event.transactionHash)
        : undefined

      await handler({
        event: {
          name: event.eventName,
          args: event.args,
          address: event.address,
          block: event.block,
          logIndex: event.logIndex,
          transactionHash: event.transactionHash,
          blockHash: event.blockHash,
          receipt,
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

    const storedVersion = await store.getVersion()
    const storedFingerprint = await store.getEventFingerprint()
    const currentFingerprint = computeEventFingerprint(contracts)

    const isFirstRun = storedVersion === undefined
    const versionChanged = !isFirstRun && storedVersion !== version
    const fingerprintKnown = storedFingerprint !== undefined
    const eventsChanged = fingerprintKnown && storedFingerprint !== currentFingerprint
    let didReplay = false

    if (!isFirstRun && (versionChanged || eventsChanged)) {
      const eventsWatermark = await store.getCursor('_events_watermark')

      if (versionChanged && !fingerprintKnown) {
        // Upgrading from an older version without fingerprint tracking —
        // can't determine which events are cached, full reset is safest.
        await store.clearDerivedState()
        await store.removeEventsFrom(0n)
        await store.removeBlockHashesFrom(0n)
        await store.deleteCursor('_indexer')
        await store.deleteCursor('_events_watermark')
      } else {
        // Gap fill: fetch only newly-added events for the cached range,
        // keeping existing cached events intact.
        if (eventsChanged && eventsWatermark !== undefined) {
          const addedKeys = getAddedEventKeys(
            storedFingerprint!,
            currentFingerprint,
          )
          if (addedKeys.length > 0) {
            await fillNewEvents(
              client,
              store,
              contracts,
              addedKeys,
              eventsWatermark,
              maxChunkSize,
              (chunk) => {
                emitter.emit('chunk', { phase: 'gap-fill', ...chunk })
              },
            )
          }
        }

        // Rebuild derived state from the (now-complete) event cache.
        await store.clearDerivedState()
        const allEvents = await store.getEvents()
        await processEvents(allEvents)

        // Advance cursor so backfill continues beyond the cached range.
        if (eventsWatermark !== undefined) {
          await store.setCursor('_indexer', eventsWatermark)
        }
        didReplay = true
      }
    }

    await store.setVersion(version)
    await store.setEventFingerprint(currentFingerprint)

    // Get (possibly updated) cursors
    const cursor = await store.getCursor('_indexer')
    const eventsWatermark = await store.getCursor('_events_watermark')

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
