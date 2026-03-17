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

describe('Reindex', () => {
  it('re-fetches and processes events through new handlers on version change', async () => {
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

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // First indexer — stores owners by tokenId
    const handler1 = vi.fn(async ({ event, store: s }) => {
      await s.set('owners', `${event.args.tokenId}`, {
        tokenId: event.args.tokenId,
        owner: event.args.to,
      })
    })

    const indexer1 = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: handler1 },
        },
      },
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await indexer1.start()
    indexer1.stop()

    // Verify initial state
    expect(await store.get('owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xAlice',
    })

    // Track RPC calls to prove reindex doesn't use them
    const getContractEventsSpy = vi.spyOn(client, 'getContractEvents' as never)
    const getBlockNumberSpy = vi.spyOn(client, 'getBlockNumber' as never)

    // Create a new indexer with different handler logic — stores by address
    const handler2 = vi.fn(async ({ event, store: s }) => {
      await s.set('tokens_by_owner', `${event.args.to}`, {
        tokens: [event.args.tokenId],
        owner: event.args.to,
      })
    })

    const indexer2 = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: handler2 },
        },
      },
      version: 2, // Bumped version triggers reindex
      pollingInterval: 100_000,
    })

    // Reset spies after indexer creation
    getContractEventsSpy.mockClear()
    getBlockNumberSpy.mockClear()

    await indexer2.start()
    indexer2.stop()

    // New handler should have processed the cached events
    expect(handler2).toHaveBeenCalledTimes(2)

    // Old derived state should be cleared
    expect(await store.get('owners', '1')).toBeUndefined()

    // New derived state should exist
    const byAlice = await store.get('tokens_by_owner', '0xAlice')
    expect(byAlice).toEqual({ tokens: [1n], owner: '0xAlice' })

    const byBob = await store.get('tokens_by_owner', '0xBob')
    expect(byBob).toEqual({ tokens: [2n], owner: '0xBob' })

    // Event cache should still exist
    const cached = await store.getEvents()
    expect(cached).toHaveLength(2)
  })

  it('manual reindex replays events', async () => {
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
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()
    let counter = 0

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: {
            Transfer: async ({ event, store: s }) => {
              counter++
              await s.set('owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
                processedCount: counter,
              })
            },
          },
        },
      },
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await indexer.start()
    expect(counter).toBe(1)

    const before = await indexer.store.get('owners', '1')
    expect(before?.processedCount).toBe(1)

    // Manual reindex
    await indexer.reindex()

    expect(counter).toBe(2)
    const after = await indexer.store.get('owners', '1')
    expect(after?.processedCount).toBe(2)

    indexer.stop()
  })
})
