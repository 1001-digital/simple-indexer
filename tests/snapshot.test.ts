import { describe, it, expect, beforeEach } from 'vitest'
import { createMemoryStore } from '../src/store/memory'
import { createSqliteStore } from '../src/store/sqlite'
import { exportSnapshot, importSnapshot } from '../src/snapshot'
import type { Store, CachedEvent } from '../src/types'

function makeEvent(overrides: Partial<CachedEvent> = {}): CachedEvent {
  return {
    block: 100n,
    logIndex: 0,
    contractName: 'Token',
    eventName: 'Transfer',
    args: { from: '0x1', to: '0x2', value: 1000000000000000000n },
    address: '0x1234' as `0x${string}`,
    transactionHash: '0xabc' as `0x${string}`,
    blockHash: '0xdef' as `0x${string}`,
    ...overrides,
  }
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  result += decoder.decode()
  return result
}

function textToStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

async function populateStore(store: Store) {
  const events = [
    makeEvent({ block: 10n, logIndex: 0 }),
    makeEvent({ block: 10n, logIndex: 1 }),
    makeEvent({ block: 20n, logIndex: 0, eventName: 'Approval' }),
  ]
  await store.appendEvents(events)
  await store.setCursor('_indexer', 20n)
  await store.setCursor('_ew:Token:Transfer', 15n)
  await store.setBlockHash(10n, '0xblock10')
  await store.setBlockHash(20n, '0xblock20')
  await store.setEventFingerprint('fp_abc123')
}

describe('snapshot', () => {
  let source: Store

  beforeEach(() => {
    source = createMemoryStore()
  })

  describe('memory store round-trip', () => {
    it('exports and imports events, cursors, and block hashes', async () => {
      await populateStore(source)

      const stream = exportSnapshot(source)
      const target = createMemoryStore()
      await importSnapshot(target, stream)

      const srcEvents = await source.getEvents()
      const tgtEvents = await target.getEvents()
      expect(tgtEvents).toEqual(srcEvents)

      expect(await target.getCursor('_indexer')).toBe(20n)
      expect(await target.getCursor('_ew:Token:Transfer')).toBe(15n)

      expect(await target.getBlockHash(10n)).toBe('0xblock10')
      expect(await target.getBlockHash(20n)).toBe('0xblock20')

      expect(await target.getEventFingerprint()).toBe('fp_abc123')
    })
  })

  describe('cross-store round-trip', () => {
    it('SQLite -> memory preserves data', async () => {
      const sqliteStore = createSqliteStore(':memory:')
      await populateStore(sqliteStore)

      const stream = exportSnapshot(sqliteStore)
      const target = createMemoryStore()
      await importSnapshot(target, stream)

      const srcEvents = await sqliteStore.getEvents()
      const tgtEvents = await target.getEvents()
      expect(tgtEvents).toEqual(srcEvents)

      expect(await target.getCursor('_indexer')).toBe(20n)
      expect(await target.getCursor('_ew:Token:Transfer')).toBe(15n)
      expect(await target.getBlockHash(10n)).toBe('0xblock10')
      expect(await target.getBlockHash(20n)).toBe('0xblock20')
    })
  })

  describe('empty store export', () => {
    it('produces valid snapshot with no events', async () => {
      const stream = exportSnapshot(source)
      const text = await streamToText(stream)
      const lines = text.trim().split('\n')

      // header + empty events (0 batches, so just cursors + blockHashes)
      expect(lines.length).toBeGreaterThanOrEqual(3)
      const header = JSON.parse(lines[0])
      expect(header.type).toBe('header')
      expect(header.version).toBe(1)

      // Can import into a fresh store without errors
      const target = createMemoryStore()
      await importSnapshot(target, textToStream(text))
      expect(await target.getEvents()).toEqual([])
    })
  })

  describe('header version validation', () => {
    it('rejects future versions', async () => {
      const badSnapshot = JSON.stringify({
        type: 'header',
        version: 99,
        eventFingerprint: undefined,
        from: undefined,
        to: undefined,
      }) + '\n'

      const target = createMemoryStore()
      await expect(
        importSnapshot(target, textToStream(badSnapshot)),
      ).rejects.toThrow('Unsupported snapshot version: 99')
    })
  })

  describe('import clears existing data', () => {
    it('wipes previous events and derived state', async () => {
      // Pre-populate target with different data
      const target = createMemoryStore()
      await target.appendEvents([makeEvent({ block: 999n })])
      await target.set('users', '1', { name: 'Alice' })
      await target.setBlockHash(999n, '0xold')

      // Import empty snapshot
      await populateStore(source)
      const stream = exportSnapshot(source)
      await importSnapshot(target, stream)

      // Old event at block 999 is gone
      const events = await target.getEvents()
      expect(events.every((e) => e.block !== 999n)).toBe(true)

      // Derived state was cleared
      expect(await target.get('users', '1')).toBeUndefined()

      // Old block hash is gone
      expect(await target.getBlockHash(999n)).toBeUndefined()

      // New data is there
      expect(events).toHaveLength(3)
      expect(await target.getBlockHash(10n)).toBe('0xblock10')
    })
  })

  describe('BigInt args survive round-trip', () => {
    it('preserves bigint values in event args', async () => {
      const event = makeEvent({
        args: { tokenId: 42n, amount: 1000000000000000000n },
      })
      await source.appendEvents([event])

      const stream = exportSnapshot(source)
      const target = createMemoryStore()
      await importSnapshot(target, stream)

      const imported = await target.getEvents()
      expect(imported[0].args.tokenId).toBe(42n)
      expect(imported[0].args.amount).toBe(1000000000000000000n)
    })
  })

  describe('events with receipts survive round-trip', () => {
    it('preserves receipt data', async () => {
      const event = makeEvent({
        receipt: {
          transactionHash: '0xtxhash' as `0x${string}`,
          blockNumber: 100n,
          logs: [
            {
              address: '0xlog1' as `0x${string}`,
              topics: ['0xtopic1' as `0x${string}`],
              data: '0xdata1' as `0x${string}`,
              logIndex: 0,
            },
          ],
        },
      })
      await source.appendEvents([event])

      const stream = exportSnapshot(source)
      const target = createMemoryStore()
      await importSnapshot(target, stream)

      const imported = await target.getEvents()
      expect(imported[0].receipt).toBeDefined()
      expect(imported[0].receipt!.transactionHash).toBe('0xtxhash')
      expect(imported[0].receipt!.blockNumber).toBe(100n)
      expect(imported[0].receipt!.logs).toHaveLength(1)
    })
  })

  describe('cursor preservation', () => {
    it('preserves _ew:* watermarks', async () => {
      await source.setCursor('_indexer', 500n)
      await source.setCursor('_ew:Token:Transfer', 400n)
      await source.setCursor('_ew:Token:Approval', 300n)

      const stream = exportSnapshot(source)
      const target = createMemoryStore()
      await importSnapshot(target, stream)

      expect(await target.getCursor('_indexer')).toBe(500n)
      expect(await target.getCursor('_ew:Token:Transfer')).toBe(400n)
      expect(await target.getCursor('_ew:Token:Approval')).toBe(300n)
    })
  })

  describe('NDJSON format', () => {
    it('produces valid parseable NDJSON lines', async () => {
      await populateStore(source)

      const stream = exportSnapshot(source)
      const text = await streamToText(stream)
      const lines = text.trim().split('\n')

      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }

      // First line is header
      const header = JSON.parse(lines[0])
      expect(header.type).toBe('header')
      expect(header.version).toBe(1)

      // Last two lines are cursors and blockHashes
      const cursors = JSON.parse(lines[lines.length - 2])
      expect(cursors.type).toBe('cursors')

      const blockHashes = JSON.parse(lines[lines.length - 1])
      expect(blockHashes.type).toBe('blockHashes')
    })
  })
})
