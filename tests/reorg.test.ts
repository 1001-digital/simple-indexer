import { describe, it, expect, vi } from 'vitest'
import { createMemoryStore } from '../src/store/memory'
import { detectReorg, handleReorg } from '../src/sync/reorg'
import { createMockClient, generateBlocks } from './helpers'

describe('Reorg detection', () => {
  it('returns undefined when no reorg', async () => {
    const blocks = generateBlocks(1, 10)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // Store the correct hash for block 10
    await store.setBlockHash(10n, blocks[9].hash)

    const result = await detectReorg(client, store, 10n)
    expect(result).toBeUndefined()
  })

  it('detects reorg when block hash changed', async () => {
    const blocks = generateBlocks(1, 10)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // Store a wrong hash for block 10
    await store.setBlockHash(10n, '0xwronghash' as `0x${string}`)
    // But correct hash for block 9
    await store.setBlockHash(9n, blocks[8].hash)

    const result = await detectReorg(client, store, 10n)
    expect(result).toBe(10n)
  })

  it('finds fork point when multiple blocks reorged', async () => {
    const blocks = generateBlocks(1, 10)
    const client = createMockClient(blocks)
    const store = createMemoryStore()

    // Blocks 8, 9, 10 have wrong hashes (deep reorg)
    await store.setBlockHash(7n, blocks[6].hash) // correct
    await store.setBlockHash(8n, '0xwrong8' as `0x${string}`)
    await store.setBlockHash(9n, '0xwrong9' as `0x${string}`)
    await store.setBlockHash(10n, '0xwrong10' as `0x${string}`)

    const result = await detectReorg(client, store, 10n)
    expect(result).toBe(8n) // reorg started at block 8
  })
})

describe('handleReorg', () => {
  it('rolls back mutations, events, and cursor', async () => {
    const store = createMemoryStore()

    // Set up state at block 5
    await store.set('owners', '1', { owner: '0xOriginal' })
    await store.recordMutation({
      block: 5n,
      table: 'owners',
      key: '1',
      op: 'set',
      previous: undefined,
    })
    await store.appendEvents([
      {
        block: 5n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { tokenId: 1n },
        address: '0x1' as `0x${string}`,
        transactionHash: '0xtx' as `0x${string}`,
        blockHash: '0xb5' as `0x${string}`,
      },
    ])

    // More state at block 10
    await store.set('owners', '1', { owner: '0xReorged' })
    await store.recordMutation({
      block: 10n,
      table: 'owners',
      key: '1',
      op: 'set',
      previous: { owner: '0xOriginal' },
    })
    await store.appendEvents([
      {
        block: 10n,
        logIndex: 0,
        contractName: 'NFT',
        eventName: 'Transfer',
        args: { tokenId: 1n },
        address: '0x1' as `0x${string}`,
        transactionHash: '0xtx2' as `0x${string}`,
        blockHash: '0xb10' as `0x${string}`,
      },
    ])
    await store.setBlockHash(10n, '0xb10' as `0x${string}`)
    await store.setCursor('_indexer', 10n)

    // Handle reorg from block 10
    await handleReorg(store, 10n)

    // State should be rolled back
    expect(await store.get('owners', '1')).toEqual({ owner: '0xOriginal' })

    // Events from block 10 should be removed
    const events = await store.getEvents()
    expect(events).toHaveLength(1)
    expect(events[0].block).toBe(5n)

    // Block hash should be removed
    expect(await store.getBlockHash(10n)).toBeUndefined()

    // Cursor should be at 9
    expect(await store.getCursor('_indexer')).toBe(9n)
  })

  it('rolls back per-event watermarks when contracts are provided', async () => {
    const store = createMemoryStore()

    await store.setCursor('_indexer', 10n)
    await store.setCursor('_ew:NFT:Transfer', 10n)
    await store.setCursor('_ew:NFT:Approval', 10n)

    const contracts = {
      NFT: { events: { Transfer: () => {}, Approval: () => {} } },
    }

    await handleReorg(store, 8n, contracts as any)

    expect(await store.getCursor('_indexer')).toBe(7n)
    expect(await store.getCursor('_ew:NFT:Transfer')).toBe(7n)
    expect(await store.getCursor('_ew:NFT:Approval')).toBe(7n)
  })
})
