import { describe, it, expect, vi } from 'vitest'
import { createMemoryStore } from '../src/store/memory'
import {
  indexer,
  createHttpHandler,
  http,
  fallback,
  createView,
  SourceMiss,
} from '../src/query'
import { stringify, parse } from '../src/utils/json'
import type { CachedEvent } from '../src/types'
import type { Source, SourceResult } from '../src/query'
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

const NFT_ADDRESS = '0xNFT' as `0x${string}`

function seedEvents(): CachedEvent[] {
  return [
    {
      block: 3n,
      logIndex: 0,
      contractName: 'NFT',
      eventName: 'Transfer',
      args: { from: '0x0', to: '0xAlice', tokenId: 1n },
      address: NFT_ADDRESS,
      transactionHash: '0xtx1' as `0x${string}`,
      blockHash: '0xb3' as `0x${string}`,
    },
    {
      block: 5n,
      logIndex: 0,
      contractName: 'NFT',
      eventName: 'Transfer',
      args: { from: '0x0', to: '0xBob', tokenId: 2n },
      address: NFT_ADDRESS,
      transactionHash: '0xtx2' as `0x${string}`,
      blockHash: '0xb5' as `0x${string}`,
    },
    {
      block: 7n,
      logIndex: 0,
      contractName: 'NFT',
      eventName: 'Transfer',
      args: { from: '0xAlice', to: '0xBob', tokenId: 1n },
      address: NFT_ADDRESS,
      transactionHash: '0xtx3' as `0x${string}`,
      blockHash: '0xb7' as `0x${string}`,
    },
  ]
}

async function setup() {
  const store = createMemoryStore()
  await store.appendEvents(seedEvents())
  await store.setCursor('_indexer', 10n)
  const source = indexer({ store })
  return { store, source }
}

// ─── JSON utilities ──────────────────────────────────────────

describe('json utils', () => {
  it('roundtrips bigints', () => {
    const data = { a: 1n, b: 'hello', c: 0n, d: -42n }
    const result = parse<typeof data>(stringify(data))
    expect(result.a).toBe(1n)
    expect(result.b).toBe('hello')
    expect(result.c).toBe(0n)
    expect(result.d).toBe(-42n)
  })

  it('roundtrips nested bigints', () => {
    const data = { args: { tokenId: 123456789n }, block: 42n }
    const result = parse<typeof data>(stringify(data))
    expect(result.args.tokenId).toBe(123456789n)
    expect(result.block).toBe(42n)
  })
})

// ─── HTTP handler ─────────────────────────────────────────────

describe('createHttpHandler', () => {
  it('POST returns events as JSON', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ address: NFT_ADDRESS }),
    })

    const res = await handler(req)
    expect(res.status).toBe(200)

    const result = parse<SourceResult>(await res.text())
    expect(result.events).toHaveLength(3)
    expect(result.toBlock).toBe(10n)
  })

  it('POST preserves bigints in args', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ address: NFT_ADDRESS, args: { tokenId: 1n } }),
    })

    const res = await handler(req)
    const result = parse<SourceResult>(await res.text())
    expect(result.events).toHaveLength(2)
    expect(result.events[0].args.tokenId).toBe(1n)
  })

  it('POST filters by eventName', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ address: NFT_ADDRESS, eventName: 'Transfer' }),
    })

    const res = await handler(req)
    const result = parse<SourceResult>(await res.text())
    expect(result.events).toHaveLength(3)
  })

  it('POST filters by block range', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ address: NFT_ADDRESS, fromBlock: 4n, toBlock: 6n }),
    })

    const res = await handler(req)
    const result = parse<SourceResult>(await res.text())
    expect(result.events).toHaveLength(1)
    expect(result.events[0].blockNumber).toBe(5n)
  })

  it('POST returns 404 on SourceMiss', async () => {
    const source: Source = {
      async getEvents() {
        throw new SourceMiss('not indexed')
      },
    }
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ address: NFT_ADDRESS }),
    })

    const res = await handler(req)
    expect(res.status).toBe(404)
  })

  it('POST returns 500 on other errors', async () => {
    const source: Source = {
      async getEvents() {
        throw new Error('db crashed')
      },
    }
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify({ address: NFT_ADDRESS }),
    })

    const res = await handler(req)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('db crashed')
  })

  it('returns 405 for unsupported methods', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', { method: 'PUT' })
    const res = await handler(req)
    expect(res.status).toBe(405)
  })

  it('handles OPTIONS for CORS preflight', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({ source, cors: true })

    const req = new Request('http://localhost/', { method: 'OPTIONS' })
    const res = await handler(req)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('CORS with custom origin', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({
      source,
      cors: 'https://app.example.com',
    })

    const req = new Request('http://localhost/', {
      method: 'POST',
      body: stringify({ address: NFT_ADDRESS }),
    })

    const res = await handler(req)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example.com',
    )
  })

  it('SSE returns 501 when onSubscribe not configured', async () => {
    const { source } = await setup()
    const handler = createHttpHandler({ source })

    const req = new Request('http://localhost/', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    })

    const res = await handler(req)
    expect(res.status).toBe(501)
  })

  it('SSE streams change events', async () => {
    const { source } = await setup()
    const listeners: (() => void)[] = []

    const handler = createHttpHandler({
      source,
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
    listeners.forEach((fn) => fn())

    const { value: chunk2 } = await reader.read()
    expect(decoder.decode(chunk2)).toBe('event: change\ndata: {}\n\n')

    // Cleanup
    controller.abort()
  })
})

// ─── HTTP source ──────────────────────────────────────────────

describe('http source', () => {
  it('full roundtrip through handler', async () => {
    const { source: serverSource } = await setup()
    const handler = createHttpHandler({ source: serverSource })

    // Create http source with custom fetch that calls handler directly
    const clientSource = http({
      url: 'http://localhost/',
      fetch: (input, init) => handler(new Request(input, init)),
    })

    const result = await clientSource.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    expect(result.events).toHaveLength(3)
    expect(result.toBlock).toBe(10n)
    // Verify bigints survived the roundtrip
    expect(result.events[0].blockNumber).toBe(3n)
    expect(result.events[0].args.tokenId).toBe(1n)
  })

  it('filters by eventName through roundtrip', async () => {
    const { source: serverSource } = await setup()
    const handler = createHttpHandler({ source: serverSource })

    const clientSource = http({
      url: 'http://localhost/',
      fetch: (input, init) => handler(new Request(input, init)),
    })

    const result = await clientSource.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      eventName: 'Transfer',
    })

    expect(result.events).toHaveLength(3)
  })

  it('filters by args with bigints through roundtrip', async () => {
    const { source: serverSource } = await setup()
    const handler = createHttpHandler({ source: serverSource })

    const clientSource = http({
      url: 'http://localhost/',
      fetch: (input, init) => handler(new Request(input, init)),
    })

    const result = await clientSource.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
      args: { tokenId: 1n },
    })

    expect(result.events).toHaveLength(2)
    expect(result.events[0].args.tokenId).toBe(1n)
    expect(result.events[1].args.tokenId).toBe(1n)
  })

  it('throws SourceMiss on 404', async () => {
    const source: Source = {
      async getEvents() {
        throw new SourceMiss('not indexed')
      },
    }
    const handler = createHttpHandler({ source })

    const clientSource = http({
      url: 'http://localhost/',
      fetch: (input, init) => handler(new Request(input, init)),
    })

    await expect(
      clientSource.getEvents({ address: NFT_ADDRESS, abi: testAbi }),
    ).rejects.toThrow(SourceMiss)
  })

  it('throws on server error', async () => {
    const source: Source = {
      async getEvents() {
        throw new Error('boom')
      },
    }
    const handler = createHttpHandler({ source })

    const clientSource = http({
      url: 'http://localhost/',
      fetch: (input, init) => handler(new Request(input, init)),
    })

    await expect(
      clientSource.getEvents({ address: NFT_ADDRESS, abi: testAbi }),
    ).rejects.toThrow('HTTP 500')
  })

  it('does not send abi to server', async () => {
    let receivedBody: string | undefined
    const mockSource: Source = {
      async getEvents() {
        return { events: [], fromBlock: 0n, toBlock: 0n }
      },
    }

    const clientSource = http({
      url: 'http://localhost/',
      fetch: async (input, init) => {
        receivedBody = init?.body as string
        return new Response(stringify({ events: [], fromBlock: 0n, toBlock: 0n }))
      },
    })

    await clientSource.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    const parsed = parse<Record<string, unknown>>(receivedBody!)
    expect(parsed).not.toHaveProperty('abi')
    expect(parsed).toHaveProperty('address')
  })

  it('watch calls callback on change events', async () => {
    const callback = vi.fn()

    // Mock EventSource
    let onChangeHandler: (() => void) | undefined
    const mockES = {
      addEventListener(event: string, handler: () => void) {
        if (event === 'change') onChangeHandler = handler
      },
      close: vi.fn(),
    }

    const clientSource = http({
      url: 'http://localhost/',
      EventSource: class {
        constructor() {
          return mockES as unknown as EventSource
        }
      } as unknown as typeof EventSource,
    })

    const unsub = clientSource.watch!(
      { address: NFT_ADDRESS, abi: testAbi },
      callback,
    )

    // Simulate server push
    onChangeHandler!()
    expect(callback).toHaveBeenCalledTimes(1)

    onChangeHandler!()
    expect(callback).toHaveBeenCalledTimes(2)

    unsub()
    expect(mockES.close).toHaveBeenCalled()
  })
})

// ─── Integration: http source in fallback + view ──────────────

describe('http source integration', () => {
  it('works with fallback()', async () => {
    const store = createMemoryStore()
    await store.appendEvents(seedEvents())
    await store.setCursor('_indexer', 10n)
    const serverSource = indexer({ store })
    const handler = createHttpHandler({ source: serverSource })

    const clientSource = http({
      url: 'http://localhost/',
      fetch: (input, init) => handler(new Request(input, init)),
    })

    // Use http source as fallback behind an empty indexer
    const emptyStore = createMemoryStore()
    const emptySource = indexer({ store: emptyStore })
    const source = fallback([emptySource, clientSource])

    const result = await source.getEvents({
      address: NFT_ADDRESS,
      abi: testAbi,
    })

    expect(result.events).toHaveLength(3)
  })

  it('works with createView()', async () => {
    const store = createMemoryStore()
    await store.appendEvents(seedEvents())
    await store.setCursor('_indexer', 10n)
    const serverSource = indexer({ store })
    const handler = createHttpHandler({ source: serverSource })

    const clientSource = http({
      url: 'http://localhost/',
      fetch: (input, init) => handler(new Request(input, init)),
    })

    const view = createView({
      source: clientSource,
      filter: {
        address: NFT_ADDRESS,
        abi: testAbi,
        eventName: 'Transfer',
      },
      reduce: (events) =>
        events.map((e) => ({
          to: e.args.to as string,
          tokenId: e.args.tokenId as bigint,
        })),
    })

    const transfers = await view.get()
    expect(transfers).toHaveLength(3)
    expect(transfers[0]).toEqual({ to: '0xAlice', tokenId: 1n })
    expect(transfers[2]).toEqual({ to: '0xBob', tokenId: 1n })
  })
})
