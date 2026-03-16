import { chunkRange } from '../utils/block-ranges.js'
import { storeBlockHashesFromEvents } from './reorg.js'
import type { Store, ContractConfig, CachedEvent } from '../types.js'
import type { PublicClient } from 'viem'

export interface BackfillOptions {
  client: PublicClient
  store: Store
  contracts: Record<string, ContractConfig>
  from: bigint
  to: bigint
  chunkSize: number
  processEvents: (events: CachedEvent[]) => Promise<void>
  onProgress: (currentBlock: bigint) => void
  shouldStop: () => boolean
}

async function fetchContractEvents(
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

  if (contractFrom > to) return []

  const logs = await client.getContractEvents({
    address: contract.address as `0x${string}`,
    abi: contract.abi,
    fromBlock: contractFrom,
    toBlock: to,
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
    chunkSize,
    processEvents,
    onProgress,
    shouldStop,
  } = options
  const chunks = chunkRange(from, to, chunkSize)

  for (const [chunkFrom, chunkTo] of chunks) {
    if (shouldStop()) return

    // Fetch events from all contracts for this chunk in parallel
    const perContract = await Promise.all(
      Object.entries(contracts).map(([name, contract]) =>
        fetchContractEvents(client, name, contract, chunkFrom, chunkTo),
      ),
    )
    const allEvents: CachedEvent[] = perContract.flat()

    // Sort by (block, logIndex) for deterministic ordering
    allEvents.sort((a, b) => {
      if (a.block !== b.block) return a.block < b.block ? -1 : 1
      return a.logIndex - b.logIndex
    })

    // Cache raw events
    if (allEvents.length > 0) {
      await store.appendEvents(allEvents)
    }

    // Run event handlers
    await processEvents(allEvents)

    // Store block hashes from events we already have (free), plus the
    // chunk-end block if no event covered it.
    await storeBlockHashesFromEvents(store, allEvents)
    if (!allEvents.some((e) => e.block === chunkTo)) {
      try {
        const block = await client.getBlock({ blockNumber: chunkTo })
        await store.setBlockHash(chunkTo, block.hash)
      } catch {
        // Non-critical — reorg detection degraded but sync continues
      }
    }

    // Advance cursor
    await store.setCursor('_indexer', chunkTo)

    onProgress(chunkTo)
  }
}
