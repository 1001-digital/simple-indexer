import {
  detectReorg,
  handleReorg,
  storeBlockHashesFromEvents,
} from './reorg.js'
import { fetchAdaptiveRanges } from '../utils/adaptive-ranges.js'
import type { Store, ContractConfig, CachedEvent } from '../types.js'
import type { PublicClient } from 'viem'

export interface LiveSyncOptions {
  client: PublicClient
  store: Store
  contracts: Record<string, ContractConfig>
  processEvents: (events: CachedEvent[]) => Promise<void>
  finalityDepth: number
  chunkSize: number
  pollingInterval: number
  onChunk: (chunk: { from: bigint; to: bigint; size: number; eventCount: number }) => void
  onNewBlock: (block: bigint, head: bigint) => void
  onReorg: (fromBlock: bigint) => void
  onError: (error: Error) => void
}

export function startLiveSync(options: LiveSyncOptions): () => void {
  const {
    client,
    store,
    contracts,
    processEvents,
    finalityDepth,
    chunkSize,
    pollingInterval,
    onChunk,
    onNewBlock,
    onReorg,
    onError,
  } = options
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function getMinStartBlock(): bigint {
    return (
      Object.values(contracts).reduce(
        (min, contract) => {
          if (contract.startBlock === undefined) return min
          return min === undefined || contract.startBlock < min
            ? contract.startBlock
            : min
        },
        undefined as bigint | undefined,
      ) ?? 0n
    )
  }

  async function poll() {
    if (stopped) return

    const head = await client.getBlockNumber()
    const target = head - BigInt(finalityDepth)
    const cursor = await store.getCursor('_indexer')
    const minStartBlock = getMinStartBlock()

    if (cursor === undefined) {
      if (minStartBlock > target) return
    } else if (cursor >= target) {
      return
    }

    if (cursor !== undefined) {
      // Check for reorgs on the cursor block
      const reorgBlock = await detectReorg(client, store, cursor)
      if (reorgBlock !== undefined) {
        onReorg(reorgBlock)
        await handleReorg(store, reorgBlock)
        return // Next poll picks up from the new cursor
      }
    }

    // Fetch new events from the next unindexed block to target
    const from = cursor !== undefined ? cursor + 1n : minStartBlock

    const perContract = await Promise.all(
      Object.entries(contracts).map(async ([name, contract]) => {
        const contractFrom =
          contract.startBlock && contract.startBlock > from
            ? contract.startBlock
            : from

        const contractTo =
          contract.endBlock && contract.endBlock < target
            ? contract.endBlock
            : target

        if (contractFrom > contractTo) return []

        const ranges = await fetchAdaptiveRanges({
          from: contractFrom,
          to: contractTo,
          maxChunkSize: chunkSize,
          fetch: async (rangeFrom, rangeTo) => {
            const logs = await client.getContractEvents({
              address: contract.address as `0x${string}`,
              abi: contract.abi,
              fromBlock: rangeFrom,
              toBlock: rangeTo,
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
          },
        })

        return ranges.flatMap((range) => range.value)
      }),
    )
    const allEvents: CachedEvent[] = perContract.flat()

    allEvents.sort((a, b) => {
      if (a.block !== b.block) return a.block < b.block ? -1 : 1
      return a.logIndex - b.logIndex
    })

    onChunk({
      from,
      to: target,
      size: Number(target - from + 1n),
      eventCount: allEvents.length,
    })

    if (allEvents.length > 0) {
      await store.appendEvents(allEvents)
    }

    await processEvents(allEvents)

    // Store block hashes from events we already have (free), plus the
    // target block if no event covered it.
    await storeBlockHashesFromEvents(store, allEvents)
    if (!allEvents.some((e) => e.block === target)) {
      try {
        const block = await client.getBlock({ blockNumber: target })
        await store.setBlockHash(target, block.hash)
      } catch {
        // Non-critical
      }
    }

    await store.setCursor('_indexer', target)

    // Prune finalized mutation history
    const pruneBelow = target - BigInt(finalityDepth * 2)
    if (pruneBelow > 0n) {
      await store.pruneHistory(pruneBelow)
    }

    onNewBlock(target, head)
  }

  async function loop() {
    if (stopped) return
    try {
      await poll()
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
    if (!stopped) {
      timer = setTimeout(loop, pollingInterval)
    }
  }

  loop()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
