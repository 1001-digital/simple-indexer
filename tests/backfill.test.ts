import { describe, it, expect, vi } from 'vitest'
import { createMemoryStore } from '../src/store/memory'
import { createIndexer } from '../src/index'
import { createMockClient, generateBlocks } from './helpers'
import type { Abi } from 'viem'

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
] as const satisfies Abi

describe('Backfill', () => {
  it('indexes events from historical blocks', async () => {
    const events = {
      5: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx1' as `0x${string}`,
        },
      ],
      8: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xBob', tokenId: 2n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx2' as `0x${string}`,
        },
      ],
    }

    // Generate blocks 1-12 (head=12, finality=2 → target=10)
    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    const handler = vi.fn(async ({ event, store: s }) => {
      await s.set('owners', `${event.args.tokenId}`, {
        tokenId: event.args.tokenId,
        owner: event.args.to,
      })
    })

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: handler },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 5,
      pollingInterval: 100_000, // Don't actually poll in test
    })

    await indexer.start()

    // Handler should have been called twice
    expect(handler).toHaveBeenCalledTimes(2)

    // Derived state should be correct
    const owner1 = await indexer.store.get('owners', '1')
    expect(owner1).toEqual({ tokenId: 1n, owner: '0xAlice' })

    const owner2 = await indexer.store.get('owners', '2')
    expect(owner2).toEqual({ tokenId: 2n, owner: '0xBob' })

    // Events should be cached in the store
    const cached = await store.getEvents()
    expect(cached).toHaveLength(2)

    // Cursor should be at target (10)
    expect(await store.getCursor('_indexer')).toBe(10n)

    indexer.stop()
  })

  it('emits status updates during backfill', async () => {
    const blocks = generateBlocks(1, 12)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    const statuses: string[] = []

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: vi.fn() },
        },
      },
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    indexer.onStatus((s) => statuses.push(s.phase))

    await indexer.start()
    indexer.stop()

    expect(statuses).toContain('backfilling')
    expect(statuses).toContain('live')
  })

  it('resumes from stored cursor', async () => {
    const events = {
      3: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx1' as `0x${string}`,
        },
      ],
      8: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xBob', tokenId: 2n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx2' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // Pre-set cursor at block 5 (simulating prior partial sync)
    await store.setCursor('_indexer', 5n)
    await store.setVersion(1)

    const handler = vi.fn(async ({ event, store: s }) => {
      await s.set('owners', `${event.args.tokenId}`, {
        tokenId: event.args.tokenId,
        owner: event.args.to,
      })
    })

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: handler },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 10,
      pollingInterval: 100_000,
    })

    await indexer.start()

    // Only the event at block 8 should be processed (block 3 was before cursor)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await indexer.store.get('owners', '2')).toEqual({
      tokenId: 2n,
      owner: '0xBob',
    })
    expect(await indexer.store.get('owners', '1')).toBeUndefined()

    indexer.stop()
  })

  it('stores block hashes at chunk boundaries and from events', async () => {
    const blocks = generateBlocks(1, 12, {
      3: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx3' as `0x${string}`,
        },
      ],
      7: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xBob', tokenId: 2n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx7' as `0x${string}`,
        },
      ],
    })
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: vi.fn() },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 4,
      pollingInterval: 100_000,
    })

    await indexer.start()

    // Chunk boundaries (maxChunkSize=4, range 1-10): chunks [1,4], [5,8], [9,10]
    expect(await store.getBlockHash(4n)).toBeDefined()
    expect(await store.getBlockHash(8n)).toBeDefined()
    expect(await store.getBlockHash(10n)).toBeDefined()

    // Event blocks get hashes for free
    expect(await store.getBlockHash(3n)).toBeDefined()
    expect(await store.getBlockHash(7n)).toBeDefined()

    // Blocks without events or chunk boundaries have no hash
    expect(await store.getBlockHash(1n)).toBeUndefined()
    expect(await store.getBlockHash(6n)).toBeUndefined()

    indexer.stop()
  })

  it('shrinks chunk ranges when the RPC rejects large backfill spans', async () => {
    const events = {
      6: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx6' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
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

    const store = createMemoryStore()

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: vi.fn() },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 8,
      pollingInterval: 100_000,
    })

    await indexer.start()

    expect(await store.getCursor('_indexer')).toBe(10n)
    expect(await store.getEvents()).toHaveLength(1)
    expect(
      getContractEvents.mock.calls.some(([params]) => {
        const from = (params as Record<string, unknown>).fromBlock as bigint
        const to = (params as Record<string, unknown>).toBlock as bigint
        return to - from + 1n > 3n
      }),
    ).toBe(true)

    indexer.stop()
  })

  it('replays cached events without hitting RPC', async () => {
    const events = {
      3: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx3' as `0x${string}`,
        },
      ],
      8: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xBob', tokenId: 2n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx8' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // Simulate a previous run that fully processed blocks 1-5:
    // cache the event at block 3 and set the per-event watermark to 5
    await store.appendEvents([
      {
        block: 3n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0x0', to: '0xAlice', tokenId: 1n },
        address: '0xNFT' as `0x${string}`,
        transactionHash: '0xtx3' as `0x${string}`,
        blockHash: blocks[2].hash,
      },
    ])
    await store.setCursor('_ew:NFT:Transfer', 5n)
    await store.setEventFingerprint('NFT:Transfer')
    await store.setVersion(1)

    const getContractEventsSpy = vi.spyOn(client, 'getContractEvents')

    const handler = vi.fn(async ({ event, store: s }) => {
      await s.set('owners', `${event.args.tokenId}`, {
        tokenId: event.args.tokenId,
        owner: event.args.to,
      })
    })

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: handler },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 5,
      pollingInterval: 100_000,
    })

    const chunks: { cached: boolean; from: bigint }[] = []
    indexer.onChunk((c) => chunks.push({ cached: !!c.cached, from: c.from }))

    await indexer.start()

    // Both events should have been processed
    expect(handler).toHaveBeenCalledTimes(2)
    expect(await indexer.store.get('owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xAlice',
    })
    expect(await indexer.store.get('owners', '2')).toEqual({
      tokenId: 2n,
      owner: '0xBob',
    })

    // First chunk [1-5] should be cached, second chunk [6-10] should not
    expect(chunks[0]).toEqual({ cached: true, from: 1n })
    expect(chunks[1]).toEqual({ cached: false, from: 6n })

    // No RPC call should have been made for blocks 1-5
    for (const [params] of getContractEventsSpy.mock.calls) {
      const p = params as Record<string, unknown>
      expect(p.fromBlock as bigint).toBeGreaterThanOrEqual(6n)
    }

    indexer.stop()
  })

  it('replays from cache after cancel mid-handler (watermark ahead of cursor)', async () => {
    const events = {
      3: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx3' as `0x${string}`,
        },
      ],
      8: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xBob', tokenId: 2n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx8' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // Simulate: previous run processed chunks [1-5] and [6-10].
    // Events for [6-10] were cached (per-event watermark=10) but the
    // process was killed before the _indexer cursor advanced past 5.
    await store.appendEvents([
      {
        block: 3n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0x0', to: '0xAlice', tokenId: 1n },
        address: '0xNFT' as `0x${string}`,
        transactionHash: '0xtx3' as `0x${string}`,
        blockHash: blocks[2].hash,
      },
      {
        block: 8n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0x0', to: '0xBob', tokenId: 2n },
        address: '0xNFT' as `0x${string}`,
        transactionHash: '0xtx8' as `0x${string}`,
        blockHash: blocks[7].hash,
      },
    ])
    await store.setCursor('_indexer', 5n)
    await store.setCursor('_ew:NFT:Transfer', 10n)
    await store.setEventFingerprint('NFT:Transfer')
    await store.setVersion(1)

    const getContractEventsSpy = vi.spyOn(client, 'getContractEvents')

    const handler = vi.fn(async ({ event, store: s }) => {
      await s.set('owners', `${event.args.tokenId}`, {
        tokenId: event.args.tokenId,
        owner: event.args.to,
      })
    })

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: handler },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 5,
      pollingInterval: 100_000,
    })

    const chunks: { cached: boolean; from: bigint }[] = []
    indexer.onChunk((c) => chunks.push({ cached: !!c.cached, from: c.from }))

    await indexer.start()

    // Only the block 8 event should be processed (block 3 is before cursor)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await indexer.store.get('owners', '2')).toEqual({
      tokenId: 2n,
      owner: '0xBob',
    })

    // The chunk [6-10] should come from cache (watermark=10 >= chunkTo)
    expect(chunks[0]).toEqual({ cached: true, from: 6n })

    // No RPC calls for event fetching
    expect(getContractEventsSpy).not.toHaveBeenCalled()

    indexer.stop()
  })

  it('falls back to RPC when watermark is missing (incomplete cache)', async () => {
    const events = {
      3: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx3' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // Cache events but NO watermark — simulates a crash mid-chunk
    await store.appendEvents([
      {
        block: 3n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0x0', to: '0xAlice', tokenId: 1n },
        address: '0xNFT' as `0x${string}`,
        transactionHash: '0xtx3' as `0x${string}`,
        blockHash: blocks[2].hash,
      },
    ])
    await store.setVersion(1)

    const getContractEventsSpy = vi.spyOn(client, 'getContractEvents')

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: vi.fn() },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 5,
      pollingInterval: 100_000,
    })

    await indexer.start()

    // All chunks should have been fetched from RPC (no watermark = not cached)
    expect(getContractEventsSpy).toHaveBeenCalled()

    // No duplicate events — stale ones should have been cleaned up
    const cached = await store.getEvents()
    const block3Events = cached.filter((e) => e.block === 3n)
    expect(block3Events).toHaveLength(1)

    indexer.stop()
  })
})
