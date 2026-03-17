import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteStore } from '../src/store/sqlite'
import type { Store } from '../src/types'

describe('SqliteStore', () => {
  let store: Store

  beforeEach(() => {
    store = createSqliteStore(':memory:')
  })

  describe('CRUD', () => {
    it('get returns undefined for missing keys', async () => {
      expect(await store.get('users', '1')).toBeUndefined()
    })

    it('set and get', async () => {
      await store.set('users', '1', { name: 'Alice' })
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })

    it('handles bigint values via serialization', async () => {
      await store.set('tokens', '1', { tokenId: 42n, owner: '0xabc' })
      const result = await store.get('tokens', '1')
      expect(result).toEqual({ tokenId: 42n, owner: '0xabc' })
    })

    it('update merges partial data', async () => {
      await store.set('users', '1', { name: 'Alice', age: 30 })
      await store.update('users', '1', { age: 31 })
      expect(await store.get('users', '1')).toEqual({ name: 'Alice', age: 31 })
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
  })

  describe('getAll', () => {
    it('returns all rows from a table', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.set('users', '2', { name: 'Bob' })
      const all = await store.getAll('users')
      expect(all).toHaveLength(2)
    })

    it('isolates tables', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.set('posts', '1', { title: 'Hello' })
      expect(await store.getAll('users')).toHaveLength(1)
      expect(await store.getAll('posts')).toHaveLength(1)
    })

    it('filters with where', async () => {
      await store.set('users', '1', { name: 'Alice', role: 'admin' })
      await store.set('users', '2', { name: 'Bob', role: 'user' })
      const admins = await store.getAll('users', { where: { role: 'admin' } })
      expect(admins).toHaveLength(1)
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
    it('set and get', async () => {
      await store.setCursor('_indexer', 12345678n)
      expect(await store.getCursor('_indexer')).toBe(12345678n)
    })
  })

  describe('mutation log + rollback', () => {
    it('rollback undoes set', async () => {
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

    it('rollback restores previous', async () => {
      await store.set('users', '1', { name: 'Alice' })
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
      await store.rollback(10n)
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })
  })

  describe('event cache', () => {
    const event1 = {
      block: 10n,
      logIndex: 0,
      contractName: 'Test',
      eventName: 'Transfer',
      args: { tokenId: 1n },
      address: '0x1234' as `0x${string}`,
      transactionHash: '0xabc' as `0x${string}`,
      blockHash: '0xdef' as `0x${string}`,
    }

    it('appendEvents and getEvents', async () => {
      await store.appendEvents([event1, { ...event1, block: 20n }])
      const events = await store.getEvents()
      expect(events).toHaveLength(2)
      expect(events[0].block).toBe(10n)
    })

    it('getEvents with range', async () => {
      await store.appendEvents([event1, { ...event1, block: 20n }])
      expect(await store.getEvents(15n)).toHaveLength(1)
      expect(await store.getEvents(undefined, 15n)).toHaveLength(1)
    })

    it('removeEventsFrom', async () => {
      await store.appendEvents([event1, { ...event1, block: 20n }])
      await store.removeEventsFrom(15n)
      expect(await store.getEvents()).toHaveLength(1)
    })
  })

  describe('clearDerivedState', () => {
    it('clears data but preserves cursors', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.setCursor('_indexer', 100n)

      await store.clearDerivedState()
      expect(await store.get('users', '1')).toBeUndefined()
      expect(await store.getCursor('_indexer')).toBe(100n)
    })
  })

  describe('version', () => {
    it('set and get', async () => {
      await store.setVersion(1)
      expect(await store.getVersion()).toBe(1)
    })
  })

  describe('block hashes', () => {
    it('set and get', async () => {
      await store.setBlockHash(100n, '0xhash')
      expect(await store.getBlockHash(100n)).toBe('0xhash')
    })

    it('removeBlockHashesFrom', async () => {
      await store.setBlockHash(100n, '0xa')
      await store.setBlockHash(200n, '0xb')
      await store.removeBlockHashesFrom(200n)
      expect(await store.getBlockHash(100n)).toBe('0xa')
      expect(await store.getBlockHash(200n)).toBeUndefined()
    })
  })
})
