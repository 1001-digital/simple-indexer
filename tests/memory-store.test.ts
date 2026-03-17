import { describe, it, expect, beforeEach } from 'vitest'
import { createMemoryStore } from '../src/store/memory'
import type { Store } from '../src/types'

describe('MemoryStore', () => {
  let store: Store

  beforeEach(() => {
    store = createMemoryStore()
  })

  describe('CRUD', () => {
    it('get returns undefined for missing keys', async () => {
      expect(await store.get('users', '1')).toBeUndefined()
    })

    it('set and get', async () => {
      await store.set('users', '1', { name: 'Alice' })
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })

    it('update merges partial data', async () => {
      await store.set('users', '1', { name: 'Alice', age: 30 })
      await store.update('users', '1', { age: 31 })
      expect(await store.get('users', '1')).toEqual({ name: 'Alice', age: 31 })
    })

    it('update on missing key does nothing', async () => {
      await store.update('users', '1', { age: 31 })
      expect(await store.get('users', '1')).toBeUndefined()
    })

    it('delete removes entry', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.delete('users', '1')
      expect(await store.get('users', '1')).toBeUndefined()
    })
  })

  describe('getEntry', () => {
    it('returns undefined for missing keys', async () => {
      expect(await store.getEntry('users', '1')).toBeUndefined()
    })

    it('returns value with block and logIndex metadata', async () => {
      await store.set('users', '1', { name: 'Alice' }, 100n, 5)
      const entry = await store.getEntry('users', '1')
      expect(entry).toEqual({
        value: { name: 'Alice' },
        block: 100n,
        logIndex: 5,
      })
    })

    it('defaults block and logIndex to 0', async () => {
      await store.set('users', '1', { name: 'Alice' })
      const entry = await store.getEntry('users', '1')
      expect(entry).toEqual({
        value: { name: 'Alice' },
        block: 0n,
        logIndex: 0,
      })
    })
  })

  describe('getAll', () => {
    it('returns all rows from a table', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.set('users', '2', { name: 'Bob' })
      const all = await store.getAll('users')
      expect(all).toHaveLength(2)
    })

    it('filters with where clause', async () => {
      await store.set('users', '1', { name: 'Alice', role: 'admin' })
      await store.set('users', '2', { name: 'Bob', role: 'user' })
      await store.set('users', '3', { name: 'Carol', role: 'admin' })
      const admins = await store.getAll('users', { where: { role: 'admin' } })
      expect(admins).toHaveLength(2)
    })

    it('respects limit', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.set('users', '2', { name: 'Bob' })
      await store.set('users', '3', { name: 'Carol' })
      const result = await store.getAll('users', { limit: 2 })
      expect(result).toHaveLength(2)
    })

    it('respects offset', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.set('users', '2', { name: 'Bob' })
      await store.set('users', '3', { name: 'Carol' })
      const result = await store.getAll('users', { offset: 1 })
      expect(result).toHaveLength(2)
    })

    it('returns rows sorted by block and logIndex', async () => {
      await store.set('bids', 'c', { amount: 30 }, 300n, 0)
      await store.set('bids', 'a', { amount: 10 }, 100n, 5)
      await store.set('bids', 'b', { amount: 20 }, 100n, 10)
      const all = await store.getAll('bids')
      expect(all).toEqual([
        { amount: 10 },
        { amount: 20 },
        { amount: 30 },
      ])
    })
  })

  describe('cursors', () => {
    it('returns undefined for missing cursor', async () => {
      expect(await store.getCursor('test')).toBeUndefined()
    })

    it('set and get cursor', async () => {
      await store.setCursor('test', 100n)
      expect(await store.getCursor('test')).toBe(100n)
    })

    it('overwrites cursor', async () => {
      await store.setCursor('test', 100n)
      await store.setCursor('test', 200n)
      expect(await store.getCursor('test')).toBe(200n)
    })
  })

  describe('mutation log + rollback', () => {
    it('rollback undoes set operations', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: undefined,
      })

      await store.rollback(10n)
      expect(await store.get('users', '1')).toBeUndefined()
    })

    it('rollback restores previous value on set', async () => {
      await store.set('users', '1', { name: 'Alice' })
      // Now overwrite
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: { name: 'Alice' },
      })
      await store.set('users', '1', { name: 'Bob' })

      await store.rollback(10n)
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })

    it('rollback undoes update', async () => {
      await store.set('users', '1', { name: 'Alice', age: 30 })
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'update',
        previous: { name: 'Alice', age: 30 },
      })
      await store.update('users', '1', { age: 31 })

      await store.rollback(10n)
      expect(await store.get('users', '1')).toEqual({ name: 'Alice', age: 30 })
    })

    it('rollback undoes delete', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'delete',
        previous: { name: 'Alice' },
      })
      await store.delete('users', '1')

      await store.rollback(10n)
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })

    it('rollback only affects mutations at or after fromBlock', async () => {
      // Block 5: set Alice
      await store.recordMutation({
        block: 5n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: undefined,
      })
      await store.set('users', '1', { name: 'Alice' })

      // Block 10: update to Bob
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: { name: 'Alice' },
      })
      await store.set('users', '1', { name: 'Bob' })

      // Rollback from block 10 — should restore to Alice
      await store.rollback(10n)
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })

    it('rollback restores previous block and logIndex', async () => {
      await store.set('users', '1', { name: 'Alice' }, 5n, 2)
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: { name: 'Alice' },
        previousBlock: 5n,
        previousLogIndex: 2,
      })
      await store.set('users', '1', { name: 'Bob' }, 10n, 0)

      await store.rollback(10n)
      const entry = await store.getEntry('users', '1')
      expect(entry).toEqual({
        value: { name: 'Alice' },
        block: 5n,
        logIndex: 2,
      })
    })

    it('pruneHistory removes old mutations', async () => {
      await store.recordMutation({
        block: 5n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: undefined,
      })
      await store.set('users', '1', { name: 'Alice' })
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: { name: 'Alice' },
      })
      await store.set('users', '1', { name: 'Bob' })

      await store.pruneHistory(8n)

      // Rollback from 10 should still work (mutation at 10 wasn't pruned)
      await store.rollback(10n)
      // But the mutation at 5 was pruned, so we can't rollback further
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })
  })

  describe('event cache', () => {
    const event1 = {
      block: 10n,
      logIndex: 0,
      contractName: 'Test',
      eventName: 'Transfer',
      args: { from: '0x1', to: '0x2' },
      address: '0x1234' as `0x${string}`,
      transactionHash: '0xabc' as `0x${string}`,
      blockHash: '0xdef' as `0x${string}`,
    }

    const event2 = {
      ...event1,
      block: 20n,
      logIndex: 0,
    }

    it('appendEvents and getEvents', async () => {
      await store.appendEvents([event1, event2])
      const events = await store.getEvents()
      expect(events).toHaveLength(2)
    })

    it('getEvents with range', async () => {
      await store.appendEvents([event1, event2])
      expect(await store.getEvents(15n)).toHaveLength(1)
      expect(await store.getEvents(undefined, 15n)).toHaveLength(1)
      expect(await store.getEvents(10n, 20n)).toHaveLength(2)
    })

    it('removeEventsFrom', async () => {
      await store.appendEvents([event1, event2])
      await store.removeEventsFrom(15n)
      const events = await store.getEvents()
      expect(events).toHaveLength(1)
      expect(events[0].block).toBe(10n)
    })
  })

  describe('clearDerivedState', () => {
    it('clears user tables but preserves cursors and events', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.setCursor('_indexer', 100n)
      await store.appendEvents([
        {
          block: 10n,
          logIndex: 0,
          contractName: 'Test',
          eventName: 'Transfer',
          args: {},
          address: '0x1234' as `0x${string}`,
          transactionHash: '0xabc' as `0x${string}`,
          blockHash: '0xdef' as `0x${string}`,
        },
      ])

      await store.clearDerivedState()

      expect(await store.get('users', '1')).toBeUndefined()
      expect(await store.getCursor('_indexer')).toBe(100n)
      expect(await store.getEvents()).toHaveLength(1)
    })
  })

  describe('version', () => {
    it('returns undefined initially', async () => {
      expect(await store.getVersion()).toBeUndefined()
    })

    it('set and get', async () => {
      await store.setVersion(1)
      expect(await store.getVersion()).toBe(1)
    })
  })

  describe('block hashes', () => {
    it('set and get block hash', async () => {
      await store.setBlockHash(100n, '0xhash')
      expect(await store.getBlockHash(100n)).toBe('0xhash')
    })

    it('removeBlockHashesFrom', async () => {
      await store.setBlockHash(100n, '0xa')
      await store.setBlockHash(200n, '0xb')
      await store.setBlockHash(300n, '0xc')
      await store.removeBlockHashesFrom(200n)
      expect(await store.getBlockHash(100n)).toBe('0xa')
      expect(await store.getBlockHash(200n)).toBeUndefined()
      expect(await store.getBlockHash(300n)).toBeUndefined()
    })
  })
})
