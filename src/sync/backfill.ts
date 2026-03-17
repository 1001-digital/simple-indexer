import { forEachAdaptiveRange } from '../utils/adaptive-ranges.js'
import { storeBlockHashesFromEvents } from './reorg.js'
import type { Store, ContractConfig, CachedEvent, CachedReceipt } from '../types.js'
import type { PublicClient } from 'viem'

export interface BackfillOptions {
  client: PublicClient
  store: Store
  contracts: Record<string, ContractConfig>
  from: bigint
  to: bigint
  maxChunkSize: number
  cachedUpTo?: bigint
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

/** Fetch and cache tx receipts for events belonging to contracts with includeTransactionReceipts. */
export async function fetchAndCacheReceipts(
  client: PublicClient,
  store: Store,
  contracts: Record<string, ContractConfig>,
  events: CachedEvent[],
): Promise<void> {
  const receiptContracts = new Set(
    Object.entries(contracts)
      .filter(([, c]) => c.includeTransactionReceipts)
      .map(([name]) => name),
  )
  if (receiptContracts.size === 0) return

  const txHashes = [
    ...new Set(
      events
        .filter((e) => receiptContracts.has(e.contractName))
        .map((e) => e.transactionHash),
    ),
  ]
  if (txHashes.length === 0) return

  const receipts: CachedReceipt[] = await Promise.all(
    txHashes.map(async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash })
      return {
        transactionHash: hash,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((l) => ({
          address: l.address,
          topics: [...l.topics] as [`0x${string}`, ...`0x${string}`[]],
          data: l.data,
          logIndex: l.logIndex,
        })),
      }
    }),
  )

  await store.appendReceipts(receipts)
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

  const logs = await client.getContractEvents({
    address: contract.address as `0x${string}`,
    abi: contract.abi,
    fromBlock: contractFrom,
    toBlock: contractTo,
  })

  const events: CachedEvent[] = []
  for (const log of logs) {
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
    cachedUpTo,
    processEvents,
    onChunk,
    onProgress,
    shouldStop,
  } = options
  await forEachAdaptiveRange<FetchResult>({
    from,
    to,
    maxChunkSize,
    fetch: async (chunkFrom, chunkTo) => {
      if (shouldStop()) return { events: [], cached: false }

      // Use cached events when the watermark proves prior completion
      if (cachedUpTo !== undefined && chunkTo <= cachedUpTo) {
        const events = await store.getEvents(chunkFrom, chunkTo)
        return { events, cached: true }
      }

      // Clean up any stale events from a prior incomplete fetch
      await store.removeEventsRange(chunkFrom, chunkTo)

      const perContract = await Promise.all(
        Object.entries(contracts).map(([name, contract]) =>
          fetchContractEvents(client, name, contract, chunkFrom, chunkTo),
        ),
      )
      const events: CachedEvent[] = perContract.flat()

      events.sort((a, b) => {
        if (a.block !== b.block) return a.block < b.block ? -1 : 1
        return a.logIndex - b.logIndex
      })

      // Cache events immediately so they survive crashes during processing.
      // The watermark advances here, ahead of the _indexer cursor, so on
      // restart the backfill can replay these events from cache.
      if (events.length > 0) {
        await store.appendEvents(events)
      }

      // Fetch and cache transaction receipts for contracts that need them
      await fetchAndCacheReceipts(client, store, contracts, events)

      await store.setCursor('_events_watermark', chunkTo)

      return { events, cached: false }
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
