import type { PublicClient } from 'viem'
import { fetchAdaptiveRanges } from '../utils/adaptive-ranges.js'
import type { Source, EventFilter, SourceResult, SourceEvent } from './types.js'
import { toArray } from './utils.js'

export interface RpcSourceConfig {
  client: PublicClient
  maxChunkSize?: number
}

interface DecodedLog {
  eventName: string
  args: Record<string, unknown>
  address: `0x${string}`
  blockNumber: bigint
  logIndex: number
  transactionHash: `0x${string}`
  blockHash: `0x${string}`
}

function toSourceEvent(log: DecodedLog): SourceEvent {
  return {
    eventName: log.eventName,
    args: log.args ?? {},
    address: log.address,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    transactionHash: log.transactionHash,
    blockHash: log.blockHash,
  }
}

async function fetchEvents(
  client: PublicClient,
  address: `0x${string}`,
  filter: EventFilter,
  fromBlock: bigint,
  toBlock: bigint,
  maxChunkSize: number,
): Promise<SourceEvent[]> {
  const params: Record<string, unknown> = {
    address,
    abi: filter.abi,
  }
  if (filter.eventName) params.eventName = filter.eventName
  if (filter.args) params.args = filter.args

  const results = await fetchAdaptiveRanges({
    from: fromBlock,
    to: toBlock,
    maxChunkSize,
    fetch: (from, to) =>
      client.getContractEvents({
        ...params,
        fromBlock: from,
        toBlock: to,
      } as never),
  })

  return (results.flatMap((range) => range.value) as DecodedLog[]).map(
    toSourceEvent,
  )
}

/**
 * Create a source that fetches events directly from an RPC node.
 *
 * Handles block-range chunking automatically. Always has full chain
 * coverage but is slower than an indexer source.
 */
export function rpc(config: RpcSourceConfig): Source {
  const { client, maxChunkSize = 2000 } = config

  return {
    async getEvents(filter: EventFilter): Promise<SourceResult> {
      const currentBlock = await client.getBlockNumber()
      const fromBlock = filter.fromBlock ?? 0n
      const toBlock =
        filter.toBlock !== undefined && filter.toBlock < currentBlock
          ? filter.toBlock
          : currentBlock

      const addresses = toArray(filter.address)

      const perAddress = await Promise.all(
        addresses.map((address) =>
          fetchEvents(client, address, filter, fromBlock, toBlock, maxChunkSize),
        ),
      )

      const events = perAddress.flat()
      events.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber)
          return a.blockNumber < b.blockNumber ? -1 : 1
        return a.logIndex - b.logIndex
      })

      return { events, fromBlock, toBlock }
    },

    watch(filter: EventFilter, callback: () => void): () => void {
      const addresses = toArray(filter.address)

      const params: Record<string, unknown> = {
        abi: filter.abi,
        onLogs: () => callback(),
      }
      if (filter.eventName) params.eventName = filter.eventName
      if (filter.args) params.args = filter.args

      const unsubscribes = addresses.map((address) =>
        client.watchContractEvent({
          ...params,
          address,
        } as never),
      )

      return () => unsubscribes.forEach((unsub) => unsub())
    },
  }
}
