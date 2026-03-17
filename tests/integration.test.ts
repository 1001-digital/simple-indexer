import { describe, it, expect, vi } from 'vitest'
import { createMemoryStore, createIndexer } from '../src/index'
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

describe('Integration', () => {
  it('tracks the tip by default when finalityDepth is omitted', async () => {
    const events = {
      12: [
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
              await s.set('owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
                block: event.block,
              })
            },
          },
        },
      },
      version: 1,
      pollingInterval: 100_000,
    })

    await indexer.start()

    expect(await indexer.store.get('owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xAlice',
      block: 12n,
    })
    expect(indexer.status.currentBlock).toBe(12n)
    expect(indexer.status.latestBlock).toBe(12n)

    indexer.stop()
  })

  it('full flow: backfill → query → onChange', async () => {
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
        {
          logIndex: 1,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 2n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx2' as `0x${string}`,
        },
      ],
      7: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0xAlice', to: '0xBob', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx3' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    const changes: [string, string][] = []

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
      maxChunkSize: 5,
      pollingInterval: 100_000,
    })

    indexer.onChange((table, key) => changes.push([table, key]))

    await indexer.start()

    // Token 1 transferred from Alice to Bob
    expect(await indexer.store.get('owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xBob',
    })

    // Token 2 still with Alice
    expect(await indexer.store.get('owners', '2')).toEqual({
      tokenId: 2n,
      owner: '0xAlice',
    })

    // Query with filter
    const aliceTokens = await indexer.store.getAll('owners', {
      where: { owner: '0xAlice' },
    })
    expect(aliceTokens).toHaveLength(1)
    expect(aliceTokens[0].tokenId).toBe(2n)

    // Changes should have been emitted
    expect(changes.length).toBeGreaterThanOrEqual(3)
    expect(changes.every(([table]) => table === 'owners')).toBe(true)

    indexer.stop()
  })

  it('handles multiple contracts', async () => {
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
          contractName: 'Token',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xBob', tokenId: 100n },
          address: '0xToken' as `0x${string}`,
          transactionHash: '0xtx2' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
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
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('nft_owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
              })
            },
          },
        },
        Token: {
          abi: testAbi,
          address: '0xToken' as `0x${string}`,
          startBlock: 1n,
          events: {
            Transfer: async ({ event, store: s }) => {
              await s.set('token_holders', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                holder: event.args.to,
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

    expect(await indexer.store.get('nft_owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xAlice',
    })
    expect(await indexer.store.get('token_holders', '100')).toEqual({
      tokenId: 100n,
      holder: '0xBob',
    })

    indexer.stop()
  })

  it('only processes events that have handlers', async () => {
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
          args: { owner: '0xAlice', approved: '0xBob', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx2' as `0x${string}`,
        },
      ],
    }

    const blocks = generateBlocks(1, 12, events)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    const transferHandler = vi.fn(async ({ event, store: s }) => {
      await s.set('owners', `${event.args.tokenId}`, { owner: event.args.to })
    })
    // No handler for Approval — it should be ignored

    const indexer = createIndexer({
      client,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 1n,
          events: { Transfer: transferHandler },
        },
      },
      version: 1,
      finalityDepth: 2,
      pollingInterval: 100_000,
    })

    await indexer.start()

    expect(transferHandler).toHaveBeenCalledTimes(1)
    // Only Transfer events should be cached
    const cached = await store.getEvents()
    expect(cached.every((e) => e.eventName === 'Transfer')).toBe(true)

    indexer.stop()
  })

  it('rolls back partial writes before resuming after a restart', async () => {
    const events = {
      6: [
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

    await store.setCursor('_indexer', 5n)
    await store.setVersion(1)
    await store.recordMutation({
      block: 6n,
      table: 'owners',
      key: '1',
      op: 'set',
      previous: undefined,
    })
    await store.set('owners', '1', {
      tokenId: 1n,
      owner: '0xPartial',
      processedCount: 999,
    })
    await store.appendEvents([
      {
        block: 6n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { from: '0x0', to: '0xAlice', tokenId: 1n },
        address: '0xNFT' as `0x${string}`,
        transactionHash: '0xtx1' as `0x${string}`,
        blockHash: blocks[5].hash,
      },
    ])
    await store.setBlockHash(6n, blocks[5].hash)

    let processedCount = 0

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
              processedCount++
              await s.set('owners', `${event.args.tokenId}`, {
                tokenId: event.args.tokenId,
                owner: event.args.to,
                processedCount,
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

    expect(processedCount).toBe(1)
    expect(await indexer.store.get('owners', '1')).toEqual({
      tokenId: 1n,
      owner: '0xAlice',
      processedCount: 1,
    })

    const cached = await store.getEvents()
    expect(cached).toHaveLength(1)
    expect(cached[0].block).toBe(6n)

    indexer.stop()
  })

  it('starts indexing once a future startBlock becomes final', async () => {
    vi.useFakeTimers()

    const allBlocks = generateBlocks(1, 25, {
      20: [
        {
          logIndex: 0,
          contractName: 'NFT',
          eventName: 'Transfer',
          args: { from: '0x0', to: '0xAlice', tokenId: 1n },
          address: '0xNFT' as `0x${string}`,
          transactionHash: '0xtx20' as `0x${string}`,
        },
      ],
    })
    let head = 10n

    const client = {
      getBlockNumber: vi.fn(async () => head),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
        const block = allBlocks.find((candidate) => candidate.number === blockNumber)
        if (!block || block.number > head) {
          throw new Error(`Block ${blockNumber} not available`)
        }
        return {
          number: block.number,
          hash: block.hash,
          parentHash: block.parentHash,
        }
      }),
      getContractEvents: vi.fn(
        async ({
          address,
          fromBlock = 0n,
          toBlock = head,
        }: {
          address?: `0x${string}` | `0x${string}`[]
          fromBlock?: bigint
          toBlock?: bigint
        }) => {
          const addresses = address
            ? Array.isArray(address)
              ? address
              : [address]
            : undefined

          return allBlocks
            .filter(
              (block) =>
                block.number >= fromBlock &&
                block.number <= toBlock &&
                block.number <= head,
            )
            .flatMap((block) =>
              block.events
                .filter((event) =>
                  addresses ? addresses.includes(event.address) : true,
                )
                .map((event) => ({
                  address: event.address,
                  args: event.args,
                  blockHash: block.hash,
                  blockNumber: block.number,
                  eventName: event.eventName,
                  logIndex: event.logIndex,
                  transactionHash: event.transactionHash,
                })),
            )
        },
      ),
    } as const

    const store = createMemoryStore()

    const indexer = createIndexer({
      client: client as never,
      store,
      contracts: {
        NFT: {
          abi: testAbi,
          address: '0xNFT' as `0x${string}`,
          startBlock: 20n,
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
      pollingInterval: 100,
    })

    try {
      await indexer.start()
      expect(await indexer.store.get('owners', '1')).toBeUndefined()

      head = 25n
      await vi.advanceTimersByTimeAsync(100)
      await Promise.resolve()

      expect(await indexer.store.get('owners', '1')).toEqual({
        tokenId: 1n,
        owner: '0xAlice',
      })
      expect(await store.getCursor('_indexer')).toBe(23n)
    } finally {
      indexer.stop()
      vi.useRealTimers()
    }
  })
})
