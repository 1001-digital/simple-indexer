import { describe, it, expect, vi } from 'vitest'
import { createMemoryStore } from '../src/store/memory'
import { indexer, rpc, fallback, createView, SourceMiss } from '../src/query'
import { createMockClient, generateBlocks } from './helpers'
import type { Abi } from 'viem'
import type { CachedEvent, ContractConfig } from '../src/types'
import type { Source } from '../src/query'

const testAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'approved', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const satisfies Abi

const NFT_ADDRESS = '0xNFT' as `0x${string}`

function seedEvents(): CachedEvent[] {
  return [
    {
      block: 3n,
      logIndex: 0,
      contractName: 'NFT',
      eventName: 'Transfer',
      args: { from: '0x0', to: '0xAlice', tokenId: 1n },
      address: NFT_ADDRESS,
      transactionHash: '0xtx1' as `0x${string}`,
      blockHash: '0xb3' as `0x${string}`,
    },
    {
      block: 3n,
      logIndex: 1,
      contractName: 'NFT',
      eventName: 'Transfer',
      args: { from: '0x0', to: '0xAlice', tokenId: 2n },
      address: NFT_ADDRESS,
      transactionHash: '0xtx2' as `0x${string}`,
      blockHash: '0xb3' as `0x${string}`,
    },
    {
      block: 5n,
      logIndex: 0,
      contractName: 'NFT',
      eventName: 'Approval',
      args: { owner: '0xAlice', approved: '0xBob', tokenId: 1n },
      address: NFT_ADDRESS,
      transactionHash: '0xtx3' as `0x${string}`,
      blockHash: '0xb5' as `0x${string}`,
    },
    {
      block: 7n,
      logIndex: 0,
      contractName: 'NFT',
      eventName: 'Transfer',
      args: { from: '0xAlice', to: '0xBob', tokenId: 1n },
      address: NFT_ADDRESS,
      transactionHash: '0xtx4' as `0x${string}`,
      blockHash: '0xb7' as `0x${string}`,
    },
  ]
}

const nftContract: ContractConfig = {
  abi: testAbi,
  address: NFT_ADDRESS,
  startBlock: 1n,
  events: {
    Transfer: async () => {},
    Approval: async () => {},
  },
}

// ─── Indexer source ────────────────────────────────────────────

describe('indexer source', () => {
  async function setup() {
    const store = createMemoryStore()
    await store.appendEvents(seedEvents())
    await store.setCursor('_indexer', 10n)
    return store
  }

  it('returns all events for an address', async () => {
    const store = await setup()
    const source = indexer({ store })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    expect(result.events).toHaveLength(4)
    expect(result.toBlock).toBe(10n)
  })

  it('filters by eventName', async () => {
    const store = await setup()
    const source = indexer({ store })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      eventName: 'Transfer',
    })

    expect(result.events).toHaveLength(3)
    expect(result.events.every((e) => e.eventName === 'Transfer')).toBe(true)
  })

  it('filters by args', async () => {
    const store = await setup()
    const source = indexer({ store })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      eventName: 'Transfer',
      args: { tokenId: 1n },
    })

    expect(result.events).toHaveLength(2)
    expect(result.events[0].args.to).toBe('0xAlice')
    expect(result.events[1].args.to).toBe('0xBob')
  })

  it('filters by block range', async () => {
    const store = await setup()
    const source = indexer({ store })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      fromBlock: 4n,
      toBlock: 6n,
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0].eventName).toBe('Approval')
  })

  it('clamps toBlock to cursor', async () => {
    const store = await setup()
    const source = indexer({ store })

    // Request events up to block 100 — should be clamped to cursor (10)
    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      toBlock: 100n,
    })

    expect(result.toBlock).toBe(10n)
    expect(result.events).toHaveLength(4)
  })

  it('returns the effective toBlock when the request is narrower than the cursor', async () => {
    const store = await setup()
    const source = indexer({ store })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      toBlock: 6n,
    })

    expect(result.toBlock).toBe(6n)
    expect(result.events).toHaveLength(3)
  })

  it('throws SourceMiss if cursor not set', async () => {
    const store = createMemoryStore()
    const source = indexer({ store })

    await expect(
      source.getEvents({ address: NFT_ADDRESS, abi: testAbi }),
    ).rejects.toThrow(SourceMiss)
  })

  it('throws SourceMiss if contracts do not cover the filter', async () => {
    const store = await setup()
    const source = indexer({
      store,
      contracts: {
        NFT: nftContract,
      },
    })

    await expect(
      source.getEvents({
        address: '0xOther' as `0x${string}`,
        abi: testAbi,
      }),
    ).rejects.toThrow(SourceMiss)
  })

  it('throws SourceMiss if eventName is not handled', async () => {
    const store = await setup()
    const source = indexer({
      store,
      contracts: {
        NFT: {
          ...nftContract,
          events: { Transfer: async () => {} },
        },
      },
    })

    await expect(
      source.getEvents({
        address: NFT_ADDRESS,
        abi: testAbi,
        eventName: 'Approval',
      }),
    ).rejects.toThrow(SourceMiss)
  })

  it('case-insensitive address matching', async () => {
    const store = await setup()
    const source = indexer({ store })

    const result = await source.getEvents({
      address: '0xnft' as `0x${string}`,
      abi: testAbi,
    })

    expect(result.events).toHaveLength(4)
  })

  it('watch calls callback via onUpdate', async () => {
    const store = await setup()
    const listeners: (() => void)[] = []
    const source = indexer({
      store,
      onUpdate: (fn) => {
        listeners.push(fn)
        return () => {
          const idx = listeners.indexOf(fn)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      },
    })

    const callback = vi.fn()
    const unsub = source.watch!(
      { address: NFT_ADDRESS, abi: testAbi },
      callback,
    )

    // Simulate an update
    listeners.forEach((fn) => fn())
    expect(callback).toHaveBeenCalledTimes(1)

    unsub()
    listeners.forEach((fn) => fn())
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('watch is undefined when onUpdate is not provided', () => {
    const store = createMemoryStore()
    const source = indexer({ store })

    expect(source.watch).toBeUndefined()
  })
})

// ─── RPC source ───────────────────────────────────────────────

describe('rpc source', () => {
  const blockEvents = {
    3: [
      {
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0x0', to: '0xAlice', tokenId: 1n },
        address: NFT_ADDRESS,
        transactionHash: '0xtx1' as `0x${string}`,
      },
      {
        logIndex: 1,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0x0', to: '0xAlice', tokenId: 2n },
        address: NFT_ADDRESS,
        transactionHash: '0xtx2' as `0x${string}`,
      },
    ],
    5: [
      {
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Approval',
        args: { owner: '0xAlice', approved: '0xBob', tokenId: 1n },
        address: NFT_ADDRESS,
        transactionHash: '0xtx3' as `0x${string}`,
      },
    ],
    7: [
      {
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0xAlice', to: '0xBob', tokenId: 1n },
        address: NFT_ADDRESS,
        transactionHash: '0xtx4' as `0x${string}`,
      },
    ],
  }

  it('fetches all events from RPC', async () => {
    const blocks = generateBlocks(1, 12, blockEvents)
    const client = createMockClient(blocks)
    const source = rpc({ client })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      fromBlock: 1n,
    })

    expect(result.events).toHaveLength(4)
    expect(result.toBlock).toBe(12n)
  })

  it('filters by eventName', async () => {
    const blocks = generateBlocks(1, 12, blockEvents)
    const client = createMockClient(blocks)
    const source = rpc({ client })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      eventName: 'Transfer',
      fromBlock: 1n,
    })

    expect(result.events).toHaveLength(3)
    expect(result.events.every((e) => e.eventName === 'Transfer')).toBe(true)
  })

  it('filters by args', async () => {
    const blocks = generateBlocks(1, 12, blockEvents)
    const client = createMockClient(blocks)
    const source = rpc({ client })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      eventName: 'Transfer',
      args: { tokenId: 1n },
      fromBlock: 1n,
    })

    expect(result.events).toHaveLength(2)
  })

  it('respects block range', async () => {
    const blocks = generateBlocks(1, 12, blockEvents)
    const client = createMockClient(blocks)
    const source = rpc({ client })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      fromBlock: 4n,
      toBlock: 6n,
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0].eventName).toBe('Approval')
  })

  it('events are sorted by block and logIndex', async () => {
    const blocks = generateBlocks(1, 12, blockEvents)
    const client = createMockClient(blocks)
    const source = rpc({ client })

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      fromBlock: 1n,
    })

    for (let i = 1; i < result.events.length; i++) {
      const prev = result.events[i - 1]
      const curr = result.events[i]
      const order =
        prev.blockNumber < curr.blockNumber ||
        (prev.blockNumber === curr.blockNumber &&
          prev.logIndex <= curr.logIndex)
      expect(order).toBe(true)
    }
  })

  it('chunks large block ranges', async () => {
    const blocks = generateBlocks(1, 100, {
      50: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: NFT_ADDRESS,
          transactionHash: '0xtx1' as `0x${string}`,
        },
      ],
    })
    const client = createMockClient(blocks)
    const spy = vi.spyOn(client, 'getContractEvents' as never)

    const source = rpc({ client, chunkSize: 20 })
    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      fromBlock: 1n,
    })

    expect(result.events).toHaveLength(1)
    // 100 blocks / 20 chunk size = 5 chunks
    expect(spy).toHaveBeenCalledTimes(5)
  })

  it('shrinks failed RPC ranges and re-expands after success', async () => {
    const blocks = generateBlocks(1, 12, {
      7: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: NFT_ADDRESS,
          transactionHash: '0xtx1' as `0x${string}`,
        },
      ],
    })
    const baseClient = createMockClient(blocks)
    const getContractEvents = vi.fn(async (params: Record<string, unknown>) => {
      const from = params.fromBlock as bigint
      const to = params.toBlock as bigint
      if (to - from + 1n > 3n) {
        throw new Error('range too large')
      }
      return baseClient.getContractEvents(params as never)
    })

    const client = {
      ...baseClient,
      getContractEvents,
    } as typeof baseClient

    const source = rpc({ client, chunkSize: 8 })
    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      fromBlock: 1n,
      toBlock: 12n,
    })

    expect(result.events).toHaveLength(1)

    const attemptedSpans = getContractEvents.mock.calls.map(([params]) => {
      const from = (params as Record<string, unknown>).fromBlock as bigint
      const to = (params as Record<string, unknown>).toBlock as bigint
      return to - from + 1n
    })

    const successfulSpans = attemptedSpans.filter((span) => span <= 3n)

    expect(attemptedSpans.some((span) => span > 3n)).toBe(true)
    expect(successfulSpans.length).toBeGreaterThan(0)
    expect(successfulSpans.every((span) => span <= 3n)).toBe(true)
    expect(successfulSpans).toContain(2n)
    expect(successfulSpans).toContain(3n)
  })

  it('watch returns an unsubscribe function', () => {
    const blocks = generateBlocks(1, 12, blockEvents)
    const client = createMockClient(blocks)
    const source = rpc({ client })

    const callback = vi.fn()
    const unsub = source.watch!(
      { address: NFT_ADDRESS, abi: testAbi },
      callback,
    )

    expect(typeof unsub).toBe('function')
    unsub()
  })
})

// ─── Fallback ─────────────────────────────────────────────────

describe('fallback', () => {
  function createMockSource(
    events: { eventName: string; blockNumber: bigint }[],
    options?: { throwOnGet?: Error; supportsWatch?: boolean },
  ): Source {
    const source: Source = {
      async getEvents() {
        if (options?.throwOnGet) throw options.throwOnGet
        return {
          events: events.map((e) => ({
            ...e,
            args: {},
            address: NFT_ADDRESS,
            logIndex: 0,
            transactionHash: '0x' as `0x${string}`,
            blockHash: '0x' as `0x${string}`,
          })),
          fromBlock: 0n,
          toBlock: 10n,
        }
      },
    }

    if (options?.supportsWatch) {
      source.watch = (_filter, callback) => {
        return () => {}
      }
    }

    return source
  }

  it('returns result from first source', async () => {
    const source1 = createMockSource([
      { eventName: 'Transfer', blockNumber: 3n },
    ])
    const source2 = createMockSource([
      { eventName: 'Transfer', blockNumber: 5n },
    ])

    const source = fallback([source1, source2])
    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0].blockNumber).toBe(3n)
  })

  it('falls back on error', async () => {
    const source1 = createMockSource([], {
      throwOnGet: new Error('RPC down'),
    })
    const source2 = createMockSource([
      { eventName: 'Transfer', blockNumber: 5n },
    ])

    const source = fallback([source1, source2])
    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0].blockNumber).toBe(5n)
  })

  it('falls back on SourceMiss', async () => {
    const source1 = createMockSource([], {
      throwOnGet: new SourceMiss('not indexed'),
    })
    const source2 = createMockSource([
      { eventName: 'Transfer', blockNumber: 5n },
    ])

    const source = fallback([source1, source2])
    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    expect(result.events).toHaveLength(1)
  })

  it('does not retry on SourceMiss', async () => {
    const spy = vi.fn().mockRejectedValue(new SourceMiss())
    const source1: Source = { getEvents: spy }
    const source2 = createMockSource([
      { eventName: 'Transfer', blockNumber: 5n },
    ])

    const source = fallback([source1, source2], { retryCount: 3 })
    await source.getEvents({ address: NFT_ADDRESS, abi: testAbi })

    // Should only be called once despite retryCount: 3
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('retries on transient errors', async () => {
    let calls = 0
    const source1: Source = {
      async getEvents() {
        calls++
        if (calls <= 2) throw new Error('timeout')
        return { events: [], fromBlock: 0n, toBlock: 10n }
      },
    }

    const source = fallback([source1], { retryCount: 2 })
    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    expect(calls).toBe(3)
    expect(result.events).toHaveLength(0)
  })

  it('throws last error when all sources exhausted', async () => {
    const source1 = createMockSource([], {
      throwOnGet: new Error('Source 1 down'),
    })
    const source2 = createMockSource([], {
      throwOnGet: new Error('Source 2 down'),
    })

    const source = fallback([source1, source2])
    await expect(
      source.getEvents({ address: NFT_ADDRESS, abi: testAbi }),
    ).rejects.toThrow('Source 2 down')
  })

  it('throws when created with no sources', () => {
    expect(() => fallback([])).toThrow('at least one source')
  })

  it('watch uses first source that supports it', () => {
    const source1 = createMockSource([])
    const source2 = createMockSource([], { supportsWatch: true })

    const source = fallback([source1, source2])
    const callback = vi.fn()
    const unsub = source.watch!(
      { address: NFT_ADDRESS, abi: testAbi },
      callback,
    )

    expect(typeof unsub).toBe('function')
    unsub()
  })

  it('watch throws if no source supports it', () => {
    const source1 = createMockSource([])
    const source2 = createMockSource([])

    const source = fallback([source1, source2])

    expect(() =>
      source.watch!({ address: NFT_ADDRESS, abi: testAbi }, vi.fn()),
    ).toThrow('No source supports watching')
  })

  it('ranks sources by latency when rank is enabled', async () => {
    let callOrder: number[] = []

    const slowSource: Source = {
      async getEvents() {
        callOrder.push(1)
        await new Promise((r) => setTimeout(r, 50))
        return { events: [], fromBlock: 0n, toBlock: 10n }
      },
    }

    const fastSource: Source = {
      async getEvents() {
        callOrder.push(2)
        return { events: [], fromBlock: 0n, toBlock: 10n }
      },
    }

    const source = fallback([slowSource, fastSource], { rank: true })

    // First call: slow then fast
    await source.getEvents({ address: NFT_ADDRESS, abi: testAbi })
    // Second call: after ranking, fast should go first
    callOrder = []
    await source.getEvents({ address: NFT_ADDRESS, abi: testAbi })
    expect(callOrder[0]).toBe(2)
  })
})

// ─── View ─────────────────────────────────────────────────────

describe('createView', () => {
  it('get() queries source and reduces', async () => {
    const store = createMemoryStore()
    await store.appendEvents(seedEvents())
    await store.setCursor('_indexer', 10n)

    const source = indexer({ store })

    const view = createView({
      source,
      filter: {
        address: NFT_ADDRESS,
        abi: testAbi,
        eventName: 'Transfer',
      },
      reduce: (events) =>
        events.map((e) => ({
          from: e.args.from as string,
          to: e.args.to as string,
          tokenId: e.args.tokenId as bigint,
        })),
    })

    const transfers = await view.get()

    expect(transfers).toHaveLength(3)
    expect(transfers[0]).toEqual({ from: '0x0', to: '0xAlice', tokenId: 1n })
    expect(transfers[2]).toEqual({
      from: '0xAlice',
      to: '0xBob',
      tokenId: 1n,
    })
  })

  it('get() works with fallback (indexer → rpc)', async () => {
    // Indexer source misses (no cursor)
    const store = createMemoryStore()
    const indexerSrc = indexer({ store })

    // RPC source has the data
    const blocks = generateBlocks(1, 12, {
      3: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: NFT_ADDRESS,
          transactionHash: '0xtx1' as `0x${string}`,
        },
      ],
    })
    const client = createMockClient(blocks)
    const rpcSrc = rpc({ client })

    const source = fallback([indexerSrc, rpcSrc])

    const view = createView({
      source,
      filter: {
        address: NFT_ADDRESS,
        abi: testAbi,
        eventName: 'Transfer',
        fromBlock: 1n,
      },
      reduce: (events) => events.length,
    })

    const count = await view.get()
    expect(count).toBe(1)
  })

  it('subscribe() emits initial data and updates', async () => {
    const store = createMemoryStore()
    await store.appendEvents(seedEvents())
    await store.setCursor('_indexer', 10n)

    const listeners: (() => void)[] = []
    const source = indexer({
      store,
      onUpdate: (fn) => {
        listeners.push(fn)
        return () => {
          const idx = listeners.indexOf(fn)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      },
    })

    const view = createView({
      source,
      filter: {
        address: NFT_ADDRESS,
        abi: testAbi,
        eventName: 'Transfer',
      },
      reduce: (events) => events.length,
    })

    const results: number[] = []
    const unsub = view.subscribe((count) => results.push(count))

    // Wait for initial fetch
    await new Promise((r) => setTimeout(r, 10))
    expect(results).toEqual([3])

    // Simulate a new event
    await store.appendEvents([
      {
        block: 9n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0xBob', to: '0xCharlie', tokenId: 1n },
        address: NFT_ADDRESS,
        transactionHash: '0xtx5' as `0x${string}`,
        blockHash: '0xb9' as `0x${string}`,
      },
    ])

    // Trigger update
    listeners.forEach((fn) => fn())
    await new Promise((r) => setTimeout(r, 10))

    expect(results).toEqual([3, 4])

    unsub()
  })

  it('subscribe() throws when source has no watch', () => {
    const store = createMemoryStore()
    const source = indexer({ store: createMemoryStore() })

    const view = createView({
      source,
      filter: { address: NFT_ADDRESS, abi: testAbi },
      reduce: (events) => events,
    })

    expect(() => view.subscribe(vi.fn())).toThrow('does not support watching')
  })

  it('unsubscribe stops callbacks', async () => {
    const store = createMemoryStore()
    await store.appendEvents(seedEvents())
    await store.setCursor('_indexer', 10n)

    const listeners: (() => void)[] = []
    const source = indexer({
      store,
      onUpdate: (fn) => {
        listeners.push(fn)
        return () => {
          const idx = listeners.indexOf(fn)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      },
    })

    const view = createView({
      source,
      filter: { address: NFT_ADDRESS, abi: testAbi },
      reduce: (events) => events.length,
    })

    const results: number[] = []
    const unsub = view.subscribe((count) => results.push(count))

    await new Promise((r) => setTimeout(r, 10))
    expect(results).toHaveLength(1)

    unsub()

    // Trigger update after unsubscribe
    listeners.forEach((fn) => fn())
    await new Promise((r) => setTimeout(r, 10))

    // Should not have received more callbacks
    expect(results).toHaveLength(1)
  })
})

// ─── Integration: indexer → source → view ─────────────────────

describe('end-to-end: indexer + query layer', () => {
  it('view reads from indexer event cache', async () => {
    const events = {
      3: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: NFT_ADDRESS,
          transactionHash: '0xtx1' as `0x${string}`,
        },
        {
          logIndex: 1,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 2n },
          address: NFT_ADDRESS,
          transactionHash: '0xtx2' as `0x${string}`,
        },
      ],
      7: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0xAlice', to: '0xBob', tokenId: 1n },
          address: NFT_ADDRESS,
          transactionHash: '0xtx3' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    const { createIndexer } = await import('../src/index')

    const contracts = {
      NFT: {
        abi: testAbi,
        address: NFT_ADDRESS,
        startBlock: 1n,
        events: {
          Transfer: async () => {},
        },
      },
    }

    const myIndexer = createIndexer({
      client,
      store,
      contracts,
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await myIndexer.start()

    // Now query the event cache through a view
    const source = indexer({
      store,
      contracts,
      onUpdate: (fn) => myIndexer.onChange(fn),
    })

    const tokenHistory = createView({
      source,
      filter: {
        address: NFT_ADDRESS,
        abi: testAbi,
        eventName: 'Transfer',
        args: { tokenId: 1n },
      },
      reduce: (events) =>
        events.map((e) => ({
          from: e.args.from as string,
          to: e.args.to as string,
          block: e.blockNumber,
        })),
    })

    const history = await tokenHistory.get()

    expect(history).toEqual([
      { from: '0x0', to: '0xAlice', block: 3n },
      { from: '0xAlice', to: '0xBob', block: 7n },
    ])

    myIndexer.stop()
  })
})
