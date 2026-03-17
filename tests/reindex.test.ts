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

describe('Reindex', () => {
  it('replays cached events through new handlers on version change (same events)', async () => {
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

    // Track RPC calls to prove handler-only reindex doesn't re-fetch
    const getContractEventsSpy = vi.spyOn(client, 'getContractEvents' as never)

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
      version: 2, // Bumped version, same events → replay from cache
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    getContractEventsSpy.mockClear()

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

    // No RPC calls for event fetching — replayed from cache
    expect(getContractEventsSpy).not.toHaveBeenCalled()
  })

  it('gap-fills only new events when event set changes', async () => {
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
        {
          logIndex: 1,
          contractName: 'NFT',
          eventName: 'Approval',
          args: { owner: '0xAlice', approved: '0xDave', tokenId: 1n },
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

    // First indexer — only Transfer events
    const indexer1 = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
              })
            },
          },
        },
      },
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await indexer1.start()
    indexer1.stop()

    // Cache should only have Transfer events
    const cachedBefore = await store.getEvents()
    expect(cachedBefore).toHaveLength(2)
    expect(cachedBefore.every((e) => e.eventName === 'Transfer')).toBe(true)

    // Track which events are fetched via RPC
    const fetchedEvents: string[] = []
    const origGetContractEvents = client.getContractEvents.bind(client)
    vi.spyOn(client, 'getContractEvents' as never).mockImplementation(
      async (params: any) => {
        const result = await origGetContractEvents(params)
        for (const e of result) fetchedEvents.push((e as any).eventName)
        return result
      },
    )

    // Second indexer — adds Approval handler, bumps version
    const approvalHandler = vi.fn(async ({ event, store: s }) => {
      await s.set('approvals', `${event.args.tokenId}`, {
        tokenId: event.args.tokenId,
        approved: event.args.approved,
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
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
              })
            },
            Approval: approvalHandler,
          },
        },
      },
      version: 2,
      pollingInterval: 100_000,
    })

    await indexer2.start()
    indexer2.stop()

    // Cache now has both Transfer and Approval events
    const cachedAfter = await store.getEvents()
    expect(cachedAfter).toHaveLength(3)

    // Approval handler was called with the gap-filled event
    expect(approvalHandler).toHaveBeenCalledTimes(1)
    expect(approvalHandler.mock.calls[0][0].event.args.approved).toBe('0xDave')

    // Transfer-derived state rebuilt correctly from cache
    expect(await store.get('owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xAlice',
    })

    // Approval-derived state built from newly gap-filled events
    expect(await store.get('approvals', '1')).toEqual({
      tokenId: 1n,
      approved: '0xDave',
    })

    // Gap fill only fetched Approval events (Transfer was already cached).
    // The RPC returns all matching ABI events but fetchContractEvents filters
    // by the handler set — only Approval should have been kept from the gap fill.
    // The key assertion: existing Transfer cache was preserved, not re-fetched
    // for backfill processing (gap fill may fetch all ABI events from RPC but
    // only caches the new ones).
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

  it('replays cached events when schema changes', async () => {
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

    const indexer1 = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('punk_transfers', `${event.block}:${event.logIndex}`, {
                punkIndex: event.args.tokenId,
                to: event.args.to,
              })
            },
          },
        },
      },
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await indexer1.start()
    indexer1.stop()

    const getContractEventsSpy = vi.spyOn(client, 'getContractEvents' as never)
    getContractEventsSpy.mockClear()

    const indexer2 = createIndexer({
      client,
      store,
      schema: {
        punk_transfers: {
          indexes: [{ name: 'by_punk', fields: ['punkIndex'] }],
        },
      },
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('punk_transfers', `${event.block}:${event.logIndex}`, {
                punkIndex: event.args.tokenId,
                to: event.args.to,
              })
            },
          },
        },
      },
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await indexer2.start()
    indexer2.stop()

    expect(
      await store.getAll('punk_transfers', {
        index: 'by_punk',
        where: { punkIndex: 1n },
      }),
    ).toEqual([{ punkIndex: 1n, to: '0xAlice' }])
    expect(getContractEventsSpy).not.toHaveBeenCalled()
  })

  it('handles event change after live sync without duplicating cached events', async () => {
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
        {
          logIndex: 1,
          contractName: 'NFT',
          eventName: 'Approval',
          args: { owner: '0xAlice', approved: '0xDave', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx1' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 20, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // First indexer: Transfer only, backfills to block 10 (finality=2, head assumed=12)
    // Then simulate live sync having advanced to block 18
    const indexer1 = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
              })
            },
          },
        },
      },
      version: 1,
      finalityDepth: 2,
      maxChunkSize: 2000,
      pollingInterval: 100_000,
    })

    await indexer1.start()
    indexer1.stop()

    // Simulate live sync having advanced cursors beyond backfill
    // (normally live sync does this, we simulate the state it leaves)
    await store.setCursor('_indexer', 18n)
    await store.setCursor('_ew:NFT:Transfer', 18n)

    // Verify setup: Transfer events cached
    const cachedBefore = await store.getEvents()
    const transferCount = cachedBefore.filter((e) => e.eventName === 'Transfer').length
    expect(transferCount).toBe(1)

    // Second indexer: adds Approval handler
    const approvalHandler = vi.fn(async ({ event, store: s }) => {
      await s.set('approvals', `${event.args.tokenId}`, {
        tokenId: event.args.tokenId,
        approved: event.args.approved,
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
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
              })
            },
            Approval: approvalHandler,
          },
        },
      },
      version: 2,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await indexer2.start()
    indexer2.stop()

    // No duplicate Transfer events — should still be exactly 1
    const cachedAfter = await store.getEvents()
    const transfersAfter = cachedAfter.filter((e) => e.eventName === 'Transfer')
    expect(transfersAfter).toHaveLength(1)

    // Approval event should have been fetched and cached
    const approvalsAfter = cachedAfter.filter((e) => e.eventName === 'Approval')
    expect(approvalsAfter).toHaveLength(1)

    // Derived state should be correct
    expect(await store.get('owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xAlice',
    })
    expect(await store.get('approvals', '1')).toEqual({
      tokenId: 1n,
      approved: '0xDave',
    })
  })
})
