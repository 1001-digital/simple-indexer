import { describe, it, expect, vi } from 'vitest'
import { createMemoryStore } from '../src/store/memory'
import { createDapp, createStoreHandler } from '../src/dapp'
import { stringify, parse } from '../src/utils/json'
import type { Indexer, StoreApi, IndexerStatus, ChunkInfo } from '../src/types'

// --- Helpers ---

function createMockIndexer(store: StoreApi): Indexer {
  const changeListeners: ((table: string, key: string) => void)[] = []
  return {
    start: async () => {},
    stop: () => {},
    reindex: async () => {},
    store,
    status: {
      phase: 'live',
      startBlock: 0n,
      currentBlock: 10n,
      latestBlock: 10n,
      progress: 1,
    } as IndexerStatus,
    onStatus: () => () => {},
    onChange(fn: (table: string, key: string) => void) {
      changeListeners.push(fn)
      return () => {
        const idx = changeListeners.indexOf(fn)
        if (idx >= 0) changeListeners.splice(idx, 1)
      }
    },
    onChunk: () => () => {},
    // Expose for testing
    _emitChange(table: string, key: string) {
      changeListeners.forEach((fn) => fn(table, key))
    },
  } as Indexer & { _emitChange: (table: string, key: string) => void }
}

async function seedStore() {
  const store = createMemoryStore({
    schema: {
      transfers: {
        indexes: [{ name: 'by_to', fields: ['to'] }],
      },
    },
  })

  await store.set('transfers', '1', { from: '0x0', to: '0xAlice', amount: 100n }, 1n, 0)
  await store.set('transfers', '2', { from: '0x0', to: '0xBob', amount: 200n }, 2n, 0)
  await store.set('transfers', '3', { from: '0xAlice', to: '0xBob', amount: 50n }, 3n, 0)

  return store
}

// ─── Local dapp ──────────────────────────────────────────────

describe('local dapp', () => {
  it('get returns a single row', async () => {
    const store = await seedStore()
    const indexer = createMockIndexer(store)
    const dapp = createDapp({ indexer })

    const row = await dapp.get('transfers', '1')
    expect(row).toEqual({ from: '0x0', to: '0xAlice', amount: 100n })
  })

  it('get returns undefined for missing key', async () => {
    const store = await seedStore()
    const indexer = createMockIndexer(store)
    const dapp = createDapp({ indexer })

    const row = await dapp.get('transfers', '999')
    expect(row).toBeUndefined()
  })

  it('getAll returns all rows', async () => {
    const store = await seedStore()
    const indexer = createMockIndexer(store)
    const dapp = createDapp({ indexer })

    const rows = await dapp.getAll('transfers')
    expect(rows).toHaveLength(3)
  })

  it('getAll with where filter', async () => {
    const store = await seedStore()
    const indexer = createMockIndexer(store)
    const dapp = createDapp({ indexer })

    const rows = await dapp.getAll('transfers', { where: { to: '0xBob' } })
    expect(rows).toHaveLength(2)
  })

  it('getAll with index', async () => {
    const store = await seedStore()
    const indexer = createMockIndexer(store)
    const dapp = createDapp({ indexer })

    const rows = await dapp.getAll('transfers', {
      index: 'by_to',
      where: { to: '0xAlice' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(100n)
  })

  it('getAll with limit', async () => {
    const store = await seedStore()
    const indexer = createMockIndexer(store)
    const dapp = createDapp({ indexer })

    const rows = await dapp.getAll('transfers', { limit: 2 })
    expect(rows).toHaveLength(2)
  })

  it('subscribe receives change notifications', async () => {
    const store = await seedStore()
    const mockIndexer = createMockIndexer(store) as Indexer & {
      _emitChange: (table: string, key: string) => void
    }
    const dapp = createDapp({ indexer: mockIndexer })

    const changes: [string, string][] = []
    const unsub = dapp.subscribe((table, key) => {
      changes.push([table, key])
    })

    mockIndexer._emitChange('transfers', '1')
    mockIndexer._emitChange('transfers', '2')

    expect(changes).toEqual([
      ['transfers', '1'],
      ['transfers', '2'],
    ])

    unsub()
    mockIndexer._emitChange('transfers', '3')
    expect(changes).toHaveLength(2) // no new change after unsub
  })
})

// ─── Store handler ───────────────────────────────────────────

describe('createStoreHandler', () => {
  it('GET /:table/:key returns a row', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/transfers/1')
    const res = await handler(req)

    expect(res.status).toBe(200)
    const row = parse<Record<string, unknown>>(await res.text())
    expect(row.from).toBe('0x0')
    expect(row.amount).toBe(100n)
  })

  it('GET /:table/:key returns 404 for missing row', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/transfers/999')
    const res = await handler(req)
    expect(res.status).toBe(404)
  })

  it('POST /:table returns all rows', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({}),
    })

    const res = await handler(req)
    expect(res.status).toBe(200)
    const rows = parse<Record<string, unknown>[]>(await res.text())
    expect(rows).toHaveLength(3)
  })

  it('POST /:table with where filter', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ where: { to: '0xBob' } }),
    })

    const res = await handler(req)
    const rows = parse<Record<string, unknown>[]>(await res.text())
    expect(rows).toHaveLength(2)
  })

  it('POST /:table with index query', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ index: 'by_to', where: { to: '0xAlice' } }),
    })

    const res = await handler(req)
    const rows = parse<Record<string, unknown>[]>(await res.text())
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(100n)
  })

  it('POST /:table with limit', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ limit: 1 }),
    })

    const res = await handler(req)
    const rows = parse<Record<string, unknown>[]>(await res.text())
    expect(rows).toHaveLength(1)
  })

  it('OPTIONS returns CORS preflight', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store, cors: true })

    const req = new Request('http://localhost/transfers', { method: 'OPTIONS' })
    const res = await handler(req)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('CORS with custom origin', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({
      store,
      cors: 'https://app.example.com',
    })

    const req = new Request('http://localhost/transfers/1')
    const res = await handler(req)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example.com',
    )
  })

  it('SSE returns 501 when onSubscribe not configured', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    })

    const res = await handler(req)
    expect(res.status).toBe(501)
  })

  it('SSE streams change events with table and key', async () => {
    const store = await seedStore()
    const listeners: ((table: string, key: string) => void)[] = []

    const handler = createStoreHandler({
      store,
      onSubscribe: (listener) => {
        listeners.push(listener)
        return () => {
          const idx = listeners.indexOf(listener)
          if (idx >= 0) listeners.splice(idx, 1)
        }
      },
    })

    const controller = new AbortController()
    const req = new Request('http://localhost/', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    })

    const res = await handler(req)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Read initial ping
    const { value: chunk1 } = await reader.read()
    expect(decoder.decode(chunk1)).toBe(': connected\n\n')

    // Trigger a change
    listeners.forEach((fn) => fn('transfers', '1'))

    const { value: chunk2 } = await reader.read()
    const text = decoder.decode(chunk2)
    expect(text).toContain('event: change')
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '))!
    const data = parse<{ table: string; key: string }>(dataLine.slice(6))
    expect(data.table).toBe('transfers')
    expect(data.key).toBe('1')

    controller.abort()
  })

  it('returns 404 for unmatched routes', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const req = new Request('http://localhost/a/b/c')
    const res = await handler(req)
    expect(res.status).toBe(404)
  })
})

// ─── Remote dapp (roundtrip through handler) ─────────────────

describe('remote dapp', () => {
  it('get roundtrip with BigInts', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const dapp = createDapp({
      url: 'http://localhost',
      fetch: async (input, init) => handler(new Request(input, init)),
    })

    const row = await dapp.get('transfers', '1')
    expect(row).toBeDefined()
    expect(row!.from).toBe('0x0')
    expect(row!.amount).toBe(100n)
  })

  it('get returns undefined for missing key', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const dapp = createDapp({
      url: 'http://localhost',
      fetch: async (input, init) => handler(new Request(input, init)),
    })

    const row = await dapp.get('transfers', '999')
    expect(row).toBeUndefined()
  })

  it('getAll roundtrip', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const dapp = createDapp({
      url: 'http://localhost',
      fetch: async (input, init) => handler(new Request(input, init)),
    })

    const rows = await dapp.getAll('transfers')
    expect(rows).toHaveLength(3)
  })

  it('getAll with where filter', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const dapp = createDapp({
      url: 'http://localhost',
      fetch: async (input, init) => handler(new Request(input, init)),
    })

    const rows = await dapp.getAll('transfers', { where: { to: '0xBob' } })
    expect(rows).toHaveLength(2)
  })

  it('getAll with indexed query over HTTP', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const dapp = createDapp({
      url: 'http://localhost',
      fetch: async (input, init) => handler(new Request(input, init)),
    })

    const rows = await dapp.getAll('transfers', {
      index: 'by_to',
      where: { to: '0xAlice' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(100n)
  })

  it('getAll with limit over HTTP', async () => {
    const store = await seedStore()
    const handler = createStoreHandler({ store })

    const dapp = createDapp({
      url: 'http://localhost',
      fetch: async (input, init) => handler(new Request(input, init)),
    })

    const rows = await dapp.getAll('transfers', { limit: 2 })
    expect(rows).toHaveLength(2)
  })

  it('subscribe receives table and key from SSE', async () => {
    const changes: [string, string][] = []

    let onChangeHandler: ((event: MessageEvent) => void) | undefined
    const mockES = {
      addEventListener(event: string, handler: (event: MessageEvent) => void) {
        if (event === 'change') onChangeHandler = handler
      },
      close: vi.fn(),
    }

    const dapp = createDapp({
      url: 'http://localhost',
      fetch: async () => new Response(''),
      EventSource: class {
        constructor() {
          return mockES as unknown as EventSource
        }
      } as unknown as typeof EventSource,
    })

    const unsub = dapp.subscribe((table, key) => {
      changes.push([table, key])
    })

    // Simulate SSE push
    onChangeHandler!(
      new MessageEvent('change', {
        data: stringify({ table: 'transfers', key: '1' }),
      }),
    )

    expect(changes).toEqual([['transfers', '1']])

    unsub()
    expect(mockES.close).toHaveBeenCalled()
  })
})
