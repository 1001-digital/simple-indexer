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

      // Attach transaction receipts before caching
      await attachReceipts(client, contracts, events)

      // Cache events immediately so they survive crashes during processing.
      // The watermark advances here, ahead of the _indexer cursor, so on
      // restart the backfill can replay these events from cache.
      if (events.length > 0) {
        await store.appendEvents(events)
      }

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
