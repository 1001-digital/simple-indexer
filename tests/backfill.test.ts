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
      chunkSize: 5,
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
      chunkSize: 10,
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
})
