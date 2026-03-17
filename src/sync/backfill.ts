import { forEachAdaptiveRange } from '../utils/adaptive-ranges.js'
import { storeBlockHashesFromEvents } from './reorg.js'
import { getEventArgs } from '../types.js'
import type { Store, ContractConfig, CachedEvent, CachedReceipt, CachedReceiptLog } from '../types.js'
import type { PublicClient } from 'viem'

export interface BackfillOptions {
  client: PublicClient
  store: Store
  contracts: Record<string, ContractConfig>
  from: bigint
  to: bigint
  maxChunkSize: number
  /** Per-event watermarks: key is "contractName:eventName", value is block up to which events are cached. */
  eventWatermarks: Map<string, bigint>
  processEvents: (events: CachedEvent[]) => Promise<void>
  onChunk?: (chunk: {
    from: bigint
    to: bigint
    size: number
    eventCount: number
    cached: boolean
  }) => void
  onProgress: (currentBlock: bigint) => void
  shouldStop: () => boolean
}

interface FetchResult {
  events: CachedEvent[]
  cached: boolean
}

/** Fetch tx receipts and attach them to events for contracts with includeTransactionReceipts. */
export async function attachReceipts(
  client: PublicClient,
  contracts: Record<string, ContractConfig>,
  events: CachedEvent[],
): Promise<void> {
  const receiptContracts = new Set(
    Object.entries(contracts)
      .filter(([, c]) => c.includeTransactionReceipts)
      .map(([name]) => name),
  )
  if (receiptContracts.size === 0) return

  const needReceipt = events.filter((e) => receiptContracts.has(e.contractName))
  const txHashes = [...new Set(needReceipt.map((e) => e.transactionHash))]
  if (txHashes.length === 0) return

  const receiptMap = new Map<`0x${string}`, CachedReceipt>()
  await Promise.all(
    txHashes.map(async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash })
      receiptMap.set(hash, {
        transactionHash: hash,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((l): CachedReceiptLog => ({
          address: l.address,
          topics: [...l.topics] as [`0x${string}`, ...`0x${string}`[]],
          data: l.data,
          logIndex: l.logIndex,
        })),
      })
    }),
  )

  for (const event of needReceipt) {
    event.receipt = receiptMap.get(event.transactionHash)
  }
}

export async function fetchContractEvents(
  client: PublicClient,
  name: string,
  contract: ContractConfig,
  from: bigint,
  to: bigint,
): Promise<CachedEvent[]> {
  const contractFrom =
    contract.startBlock && contract.startBlock > from
      ? contract.startBlock
      : from

  const contractTo =
    contract.endBlock && contract.endBlock < to ? contract.endBlock : to

  if (contractFrom > contractTo) return []

  // Split events into those with args filters and those without
  const withArgs: { eventName: string; args: Record<string, unknown> }[] = []
  const withoutArgs: string[] = []

  for (const [eventName, config] of Object.entries(contract.events)) {
    const args = getEventArgs(config)
    if (args) {
      withArgs.push({ eventName, args })
    } else {
      withoutArgs.push(eventName)
    }
  }

  const allLogs = await Promise.all([
    // Single call for all events without args filters
    ...(withoutArgs.length > 0
      ? [
          client.getContractEvents({
            address: contract.address as `0x${string}`,
            abi: contract.abi,
            fromBlock: contractFrom,
            toBlock: contractTo,
          }),
        ]
      : []),
    // Individual calls per event with args filters
    ...withArgs.map(({ eventName, args }) =>
      client.getContractEvents({
        address: contract.address as `0x${string}`,
        abi: contract.abi,
        eventName,
        args,
        fromBlock: contractFrom,
        toBlock: contractTo,
      } as any),
    ),
  ])

  const events: CachedEvent[] = []
  for (const logs of allLogs) {
    for (const log of logs as any[]) {
      if (!contract.events[log.eventName!]) continue
      events.push({
        block: log.blockNumber,
        logIndex: log.logIndex,
        contractName: name,
        eventName: log.eventName!,
        args: (log.args ?? {}) as Record<string, unknown>,
        address: log.address,
        transactionHash: log.transactionHash,
        blockHash: log.blockHash,
      })
    }
  }

  return events
}

export async function backfill(options: BackfillOptions): Promise<void> {
  const {
    client,
    store,
    contracts,
    from,
    to,
    maxChunkSize,
    eventWatermarks,
    processEvents,
    onChunk,
    onProgress,
    shouldStop,
  } = options

  // Pre-compute all event keys for cache checking
  const allEventKeys: string[] = []
  for (const [name, contract] of Object.entries(contracts)) {
    for (const eventName of Object.keys(contract.events)) {
      allEventKeys.push(`${name}:${eventName}`)
    }
  }

  await forEachAdaptiveRange<FetchResult>({
    from,
    to,
    maxChunkSize,
    fetch: async (chunkFrom, chunkTo) => {
      if (shouldStop()) return { events: [], cached: false }

      // Check if ALL events are cached for this chunk
      const allCached = allEventKeys.length > 0 && allEventKeys.every((key) => {
        const wm = eventWatermarks.get(key)
        return wm !== undefined && wm >= chunkTo
      })

      if (allCached) {
        const events = await store.getEvents(chunkFrom, chunkTo)
        return { events, cached: true }
      }

      // Check if any pre-existing watermarks cover this chunk range.
      // If so, there are cached events we need to merge with newly fetched ones.
      const hasCachedData = allEventKeys.some((key) => {
        const wm = eventWatermarks.get(key)
        return wm !== undefined && wm >= chunkFrom
      })

      // Determine which contract:event pairs need RPC fetching.
      // Events may have different watermarks, so group by effective fetch start
      // to avoid re-fetching already-cached ranges.
      const fetchedKeys: string[] = []
      const fetchCalls: Promise<CachedEvent[]>[] = []

      for (const [name, contract] of Object.entries(contracts)) {
        // Group uncached events by their effective fetch-from block
        const byFetchFrom = new Map<bigint, Record<string, (typeof contract.events)[string]>>()

        for (const [eventName, config] of Object.entries(contract.events)) {
          const key = `${name}:${eventName}`
          const wm = eventWatermarks.get(key)
          if (wm === undefined || wm < chunkTo) {
            fetchedKeys.push(key)
            const fetchFrom = wm !== undefined && wm >= chunkFrom ? wm + 1n : chunkFrom
            if (!byFetchFrom.has(fetchFrom)) byFetchFrom.set(fetchFrom, {})
            byFetchFrom.get(fetchFrom)![eventName] = config
          }
        }

        for (const [fetchFrom, events] of byFetchFrom) {
          if (fetchFrom > chunkTo) continue
          fetchCalls.push(
            fetchContractEvents(
              client,
              name,
              { ...contract, events },
              fetchFrom,
              chunkTo,
            ),
          )
        }
      }

      // If no watermarks exist at all, clean up stale events from prior incomplete fetches
      if (eventWatermarks.size === 0) {
        await store.removeEventsRange(chunkFrom, chunkTo)
      }

      // Fetch uncached events from RPC
      const newEvents: CachedEvent[] = (await Promise.all(fetchCalls)).flat()

      newEvents.sort((a, b) => {
        if (a.block !== b.block) return a.block < b.block ? -1 : 1
        return a.logIndex - b.logIndex
      })

      // Attach transaction receipts before caching
      await attachReceipts(client, contracts, newEvents)

      // Cache events immediately so they survive crashes during processing.
      // Per-event watermarks advance here, ahead of the _indexer cursor, so on
      // restart the backfill can replay these events from cache.
      if (newEvents.length > 0) {
        await store.appendEvents(newEvents)
      }

      // Update per-event watermarks for newly fetched events
      for (const key of fetchedKeys) {
        await store.setCursor(`_ew:${key}`, chunkTo)
        eventWatermarks.set(key, chunkTo)
      }

      // If there were pre-existing cached events in this range, read ALL
      // events from cache (cached + newly appended) to get the complete set
      if (hasCachedData) {
        const allEvents = await store.getEvents(chunkFrom, chunkTo)
        allEvents.sort((a, b) => {
          if (a.block !== b.block) return a.block < b.block ? -1 : 1
          return a.logIndex - b.logIndex
        })
        return { events: allEvents, cached: false }
      }

      return { events: newEvents, cached: false }
    },
    onChunk: async ({
      from: chunkFrom,
      to: chunkTo,
      value: { events, cached },
    }) => {
      if (shouldStop()) return

      onChunk?.({
        from: chunkFrom,
        to: chunkTo,
        size: Number(chunkTo - chunkFrom + 1n),
        eventCount: events.length,
        cached,
      })

      if (!cached) {
        // Store block hashes from events we already have (free), plus the
        // chunk-end block if no event covered it.
        await storeBlockHashesFromEvents(store, events)
        if (!events.some((e) => e.block === chunkTo)) {
          try {
            const block = await client.getBlock({ blockNumber: chunkTo })
            await store.setBlockHash(chunkTo, block.hash)
          } catch {
            // Non-critical — reorg detection degraded but sync continues
          }
        }
      }

      // Always run event handlers (derived state may have been rolled back)
      await processEvents(events)

      await store.setCursor('_indexer', chunkTo)
      onProgress(chunkTo)
    },
  })
}
