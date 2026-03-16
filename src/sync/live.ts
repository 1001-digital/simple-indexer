import { detectReorg, handleReorg } from './reorg.js'
import type { Store, ContractConfig, CachedEvent } from '../types.js'
import type { PublicClient } from 'viem'

export interface LiveSyncOptions {
  client: PublicClient
  store: Store
  contracts: Record<string, ContractConfig>
  processEvents: (events: CachedEvent[]) => Promise<void>
  finalityDepth: number
  pollingInterval: number
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
    pollingInterval,
    onNewBlock,
    onReorg,
    onError,
  } = options

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  async function poll() {
    if (stopped) return

    const head = await client.getBlockNumber()
    const target = head - BigInt(finalityDepth)
    const cursor = await store.getCursor('_indexer')

    if (cursor === undefined || cursor >= target) return

    // Check for reorgs on the cursor block
    const reorgBlock = await detectReorg(client, store, cursor)
    if (reorgBlock !== undefined) {
      onReorg(reorgBlock)
      await handleReorg(store, reorgBlock)
      return // Next poll picks up from the new cursor
    }

    // Fetch new events from cursor+1 to target
    const from = cursor + 1n
    const allEvents: CachedEvent[] = []

    for (const [name, contract] of Object.entries(contracts)) {
      const contractFrom =
        contract.startBlock && contract.startBlock > from
          ? contract.startBlock
          : from

      if (contractFrom > target) continue

      const logs = await client.getContractEvents({
        address: contract.address as `0x${string}`,
        abi: contract.abi,
        fromBlock: contractFrom,
        toBlock: target,
      })

      for (const log of logs) {
        if (!contract.events[log.eventName!]) continue
        allEvents.push({
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

    allEvents.sort((a, b) => {
      if (a.block !== b.block) return a.block < b.block ? -1 : 1
      return a.logIndex - b.logIndex
    })

    if (allEvents.length > 0) {
      await store.appendEvents(allEvents)
    }

    await processEvents(allEvents)

    // Store block hash for reorg detection
    try {
      const block = await client.getBlock({ blockNumber: target })
      await store.setBlockHash(target, block.hash)
    } catch {
      // Non-critical
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
