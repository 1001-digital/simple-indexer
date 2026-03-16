import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { createIdbStore } from '../src/store/idb'
import type { Store } from '../src/types'

let dbCounter = 0

describe('IdbStore', () => {
  let store: Store

  beforeEach(() => {
    store = createIdbStore(`test-db-${++dbCounter}`)
  })

  describe('CRUD', () => {
    it('get returns undefined for missing keys', async () => {
      expect(await store.get('users', '1')).toBeUndefined()
    })

    it('set and get', async () => {
      await store.set('users', '1', { name: 'Alice' })
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
    })

    it('handles bigint values in data', async () => {
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
      expect(admins[0].name).toBe('Alice')
    })

    it('respects limit', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.set('users', '2', { name: 'Bob' })
      await store.set('users', '3', { name: 'Carol' })
      const result = await store.getAll('users', { limit: 2 })
      expect(result).toHaveLength(2)
    })
  })

  describe('cursors', () => {
    it('set and get cursor with bigint', async () => {
      await store.setCursor('_indexer', 12345678n)
      expect(await store.getCursor('_indexer')).toBe(12345678n)
    })

    it('returns undefined for missing cursor', async () => {
      expect(await store.getCursor('_indexer')).toBeUndefined()
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

    it('rollback restores previous value', async () => {
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
      // Note: IDB stores use serialization, so previous values are serialized too
      expect(await store.get('users', '1')).toEqual({ name: 'Alice' })
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
  })

  describe('event cache', () => {
    const event1 = {
      block: 10n,
      logIndex: 0,
      contractName: 'Test',
      eventName: 'Transfer',
      args: { tokenId: 1n, to: '0x123' },
      address: '0x1234' as `0x${string}`,
      transactionHash: '0xabc' as `0x${string}`,
      blockHash: '0xdef' as `0x${string}`,
    }

    it('appendEvents and getEvents', async () => {
      await store.appendEvents([event1])
      const events = await store.getEvents()
      expect(events).toHaveLength(1)
      expect(events[0].block).toBe(10n)
      expect(events[0].args.tokenId).toBe(1n)
    })

    it('removeEventsFrom', async () => {
      await store.appendEvents([event1, { ...event1, block: 20n }])
      await store.removeEventsFrom(15n)
      const events = await store.getEvents()
      expect(events).toHaveLength(1)
      expect(events[0].block).toBe(10n)
    })
  })

  describe('clearDerivedState', () => {
    it('clears data and mutations', async () => {
      await store.set('users', '1', { name: 'Alice' })
      await store.recordMutation({
        block: 10n,
        table: 'users',
        key: '1',
        op: 'set',
        previous: undefined,
      })
      await store.setCursor('_indexer', 100n)

      await store.clearDerivedState()

      expect(await store.get('users', '1')).toBeUndefined()
      expect(await store.getCursor('_indexer')).toBe(100n) // cursors preserved
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
