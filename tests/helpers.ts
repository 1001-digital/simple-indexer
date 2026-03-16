import type { PublicClient } from 'viem'
import type { CachedEvent } from '../src/types'

interface MockBlock {
  number: bigint
  hash: `0x${string}`
  parentHash: `0x${string}`
  events: Omit<CachedEvent, 'blockHash'>[]
}

/**
 * Creates a mock viem PublicClient for testing.
 * Supply a list of blocks with their events.
 */
export function createMockClient(blocks: MockBlock[]): PublicClient {
  const blocksByNumber = new Map(blocks.map((b) => [b.number, b]))

  // Build event lookup: contractAddress+eventName → events in block range
  function getEventsInRange(
    address: `0x${string}` | `0x${string}`[] | undefined,
    fromBlock: bigint,
    toBlock: bigint,
  ) {
    const addresses = address
      ? Array.isArray(address)
        ? address
        : [address]
      : undefined

    const result: (CachedEvent & { eventName: string })[] = []

    for (const block of blocks) {
      if (block.number < fromBlock || block.number > toBlock) continue
      for (const event of block.events) {
        if (addresses && !addresses.includes(event.address)) continue
        result.push({
          ...event,
          blockHash: block.hash,
        })
      }
    }

    return result
  }

  return {
    getBlockNumber: async () => {
      return blocks.length > 0 ? blocks[blocks.length - 1].number : 0n
    },

    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const block = blocksByNumber.get(blockNumber)
      if (!block) throw new Error(`Block ${blockNumber} not found`)
      return {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
      }
    },

    getContractEvents: async (params: {
      address?: `0x${string}` | `0x${string}`[]
      abi?: unknown
      eventName?: string
      args?: Record<string, unknown>
      fromBlock?: bigint
      toBlock?: bigint
    }) => {
      const from = params.fromBlock ?? 0n
      const to = params.toBlock ?? blocks[blocks.length - 1]?.number ?? 0n
      let events = getEventsInRange(params.address, from, to)

      if (params.eventName) {
        events = events.filter((e) => e.eventName === params.eventName)
      }
      if (params.args) {
        events = events.filter((e) =>
          Object.entries(params.args!).every(([k, v]) => {
            const ev = e.args[k]
            if (typeof v === 'string' && typeof ev === 'string')
              return v.toLowerCase() === ev.toLowerCase()
            return ev === v
          }),
        )
      }

      return events.map((e) => ({
        address: e.address,
        args: e.args,
        blockHash: e.blockHash,
        blockNumber: e.block,
        eventName: e.eventName,
        logIndex: e.logIndex,
        transactionHash: e.transactionHash,
      }))
    },

    watchContractEvent: (params: {
      address?: `0x${string}`
      abi?: unknown
      eventName?: string
      args?: Record<string, unknown>
      onLogs: (logs: unknown[]) => void
    }) => {
      // Return a no-op unsubscribe for testing
      return () => {}
    },
  } as unknown as PublicClient
}

/**
 * Generate a sequence of mock blocks with hashes.
 */
export function generateBlocks(
  from: number,
  to: number,
  events: Record<number, Omit<CachedEvent, 'block' | 'blockHash'>[]> = {},
): MockBlock[] {
  const blocks: MockBlock[] = []
  for (let i = from; i <= to; i++) {
    const n = BigInt(i)
    blocks.push({
      number: n,
      hash: `0x${i.toString(16).padStart(64, '0')}` as `0x${string}`,
      parentHash:
        i > from
          ? (`0x${(i - 1).toString(16).padStart(64, '0')}` as `0x${string}`)
          : ('0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`),
      events: (events[i] || []).map((e) => ({ ...e, block: n })),
    })
  }
  return blocks
}
