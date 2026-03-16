# @1001-digital/simple-indexer

Lightweight, reorg-aware EVM indexer for powering pure dApps: apps that can read and stay live from the chain directly, without giving up a path to server-backed scale.

Start in the browser with IndexedDB and let your dApp sync directly from the chain, with no indexing service in the middle. When you need shared state or faster cold starts, move the same indexer config to SQLite on a server and expose it through the built-in HTTP transport. Your contracts, handlers, and query code stay the same.

Its two-layer design keeps a raw event cache separate from derived state, so reindexing happens locally instead of hitting RPC again. Update your handler logic, bump the version, and replay cached events in seconds.

## Features

- **Browser and server** — IndexedDB in the browser, SQLite on the server, in-memory for tests. Switch stores without changing anything else
- **Live migration path** — start client-side, add a server later. The HTTP source and fallback chain make the transition seamless
- **Fast reindex** — cached events replay through new handlers locally, zero RPC calls
- **Backfill + live sync** — fetches historical events in chunks, then polls for new blocks
- **Reorg handling** — mutation log tracks every write so reorged blocks can be rolled back
- **Framework-agnostic** — no React, Vue, or framework coupling; subscribe to changes with callbacks

## Install

```sh
pnpm add @1001-digital/simple-indexer viem
```

For the SQLite store (server only):

```sh
pnpm add better-sqlite3
```

## Quick start

```ts
import { createIndexer, createMemoryStore } from '@1001-digital/simple-indexer'
import { createPublicClient, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'

const indexer = createIndexer({
  client: createPublicClient({ chain: mainnet, transport: http() }),
  store: createMemoryStore(),
  version: 1,
  contracts: {
    MyNFT: {
      abi: parseAbi([
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
      ]),
      address: '0x...',
      startBlock: 12345678n,
      events: {
        Transfer({ event, store }) {
          store.set('owners', `${event.args.tokenId}`, {
            tokenId: event.args.tokenId,
            owner: event.args.to,
          })
        },
      },
    },
  },
})

await indexer.start()

// Query derived state
const owner = await indexer.store.get('owners', '42')
const all = await indexer.store.getAll('owners', {
  where: { owner: '0x...' },
  limit: 50,
})

// React to changes
indexer.onChange((table, key) => {
  console.log(`${table}/${key} changed`)
})

// Track sync progress
indexer.onStatus((status) => {
  console.log(status.phase, status.progress)
})

indexer.stop()
```

## Examples

Real examples live in [`examples/`](./examples):

- [`examples/opepen-artifacts-all-mints.ts`](./examples/opepen-artifacts-all-mints.ts) indexes every ERC-1155 mint on Jalil's Opepen Artifacts contract at `0x03cd89170b64c9f0a392246a2e4a0c22fcd23a5b`
- [`examples/opepen-artifacts-balances.ts`](./examples/opepen-artifacts-balances.ts) tracks current holder balances and per-token supply for the same contract

They are plain TypeScript files you can adapt directly for browser or server setups.

## Stores

### Memory (universal)

```ts
import { createMemoryStore } from '@1001-digital/simple-indexer'

const store = createMemoryStore()
```

Data lives in memory. Fast, no dependencies, works everywhere. Data is lost when the process exits.

### IndexedDB (browser)

```ts
import { createIdbStore } from '@1001-digital/simple-indexer'

const store = createIdbStore('my-indexer-db')
```

Persists across page reloads. Uses a single object store with composite keys to avoid IndexedDB version bumps when new tables appear.

### SQLite (server)

```ts
import { createSqliteStore } from '@1001-digital/simple-indexer/sqlite'

const store = createSqliteStore('./data.db')
```

Imported from a separate entry point to avoid bundling `better-sqlite3` in browser builds. Uses WAL mode for performance.

## Config

```ts
createIndexer({
  client, // viem PublicClient
  store, // Store implementation
  contracts: {}, // Contract definitions (see below)
  version: 1, // Bump to trigger automatic reindex
  pollingInterval: 12_000, // ms between polls (default: 12s)
  finalityDepth: 2, // Blocks behind head to consider final (default: 2)
  chunkSize: 2000, // Blocks per backfill batch (default: 2000)
})
```

### Contract definition

```ts
{
  abi: [...],                        // viem-compatible ABI
  address: '0x...',                  // Single address or array
  startBlock: 12345678n,             // Where to start indexing (optional)
  events: {
    EventName({ event, store }) {    // Handler per event name
      // event.args, event.block, event.address, ...
      // store.set(), store.get(), store.update(), store.delete(), store.getAll()
    },
  },
}
```

## How it works

### Two-layer architecture

**Layer 1 — Event cache**: raw decoded events are appended to an internal cache during sync. This cache survives handler logic changes and is never cleared on reindex.

**Layer 2 — Derived state**: the tables your handlers create (`owners`, `transfers`, etc.). These are rebuilt from the event cache when you change handler logic.

### Sync lifecycle

1. **Start** — checks stored version against config; triggers reindex if changed
2. **Backfill** — fetches historical events in chunks from `startBlock` to `head - finalityDepth`
3. **Live** — polls for new blocks, fetches events, checks for reorgs

### Reorg handling

Every store write records the previous value in a mutation log. When a reorg is detected:

1. Block hashes are compared against the chain to find the fork point
2. All mutations from the reorged blocks are replayed in reverse
3. Cached events from those blocks are removed
4. Sync resumes from the fork point

The mutation log is pruned once blocks pass the finality depth.

### Reindex

When you change handler logic, bump the `version` number. On the next `start()`, the indexer will:

1. Clear all derived state (user tables)
2. Replay every cached event through the new handlers
3. No RPC calls needed

You can also call `indexer.reindex()` manually at any time.

## API

### Indexer

| Method / Property | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `start()`         | Begin backfill, then transition to live sync                              |
| `stop()`          | Stop all syncing                                                          |
| `reindex()`       | Clear derived state and replay cached events                              |
| `store`           | `StoreApi` for querying derived state                                     |
| `status`          | Current `{ phase, currentBlock, latestBlock, progress }`                  |
| `onStatus(fn)`    | Subscribe to status changes. Returns unsubscribe function                 |
| `onChange(fn)`    | Subscribe to store mutations `(table, key)`. Returns unsubscribe function |

### StoreApi (available in handlers and on the indexer)

| Method                        | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `get(table, key)`             | Get a single row                                            |
| `getAll(table, filter?)`      | Get rows, optionally filtered by `{ where, limit, offset }` |
| `set(table, key, value)`      | Create or overwrite a row                                   |
| `update(table, key, partial)` | Merge partial data into an existing row                     |
| `delete(table, key)`          | Remove a row                                                |

## Query layer

The query layer lets you read events from any source — a local indexer, a remote server, or an RPC node — using a single `Source` interface. Sources compose with `fallback()` for automatic failover, and `createView()` for reactive queries.

### Sources

A source implements `getEvents(filter)` and optionally `watch(filter, callback)`.

#### `indexer()` — read from a local indexer's event cache

```ts
import {
  createIndexer,
  createMemoryStore,
  indexer,
} from '@1001-digital/simple-indexer'

const myIndexer = createIndexer({ client, store, contracts, version: 1 })
await myIndexer.start()

const source = indexer({
  store: myIndexer.store,
  contracts,
  onUpdate: (fn) => myIndexer.onChange(fn),
})
```

#### `rpc()` — fetch directly from an RPC node

```ts
import { rpc } from '@1001-digital/simple-indexer'

const source = rpc({ client })
```

#### `http()` — query a remote indexer over HTTP

```ts
import { http } from '@1001-digital/simple-indexer'

const source = http({ url: 'https://api.example.com/events' })
```

The `http()` source sends queries as POST requests and subscribes to changes via SSE. This lets a browser client query a server-side indexer without same-process access to the store.

#### `fallback()` — automatic failover across sources

```ts
import { fallback } from '@1001-digital/simple-indexer'

const source = fallback([
  indexer({ store, contracts }), // Try local cache first
  http({ url: '/api/events' }), // Fall back to remote server
  rpc({ client }), // Last resort: RPC
])
```

Sources are tried in order. On `SourceMiss` or error, the next source is attempted. Enable `rank: true` to auto-reorder by observed latency.

### Views

A view combines a source, a filter, and a reduce function into a reactive query.

```ts
import { createView } from '@1001-digital/simple-indexer'

const ownersView = createView({
  source,
  filter: {
    address: '0xNFT...',
    abi: nftAbi,
    eventName: 'Transfer',
  },
  reduce: (events) => {
    const owners = new Map<bigint, string>()
    for (const e of events) {
      owners.set(e.args.tokenId as bigint, e.args.to as string)
    }
    return owners
  },
})

// One-shot query
const owners = await ownersView.get()

// Reactive — re-runs reduce on every source change
const unsub = ownersView.subscribe((owners) => {
  console.log('owners updated', owners.size)
})
```

### Serving over HTTP

Expose any source over HTTP with `createHttpHandler()`. The handler uses Web standard `Request`/`Response` and works with any runtime.

```ts
import { createHttpHandler, indexer } from '@1001-digital/simple-indexer'

const source = indexer({ store, contracts })

const handler = createHttpHandler({
  source,
  // Enable SSE for watch() support
  onSubscribe: (listener) => myIndexer.onChange(listener),
  // Enable CORS (true = allow all, or pass an origin string)
  cors: true,
})
```

Wire the handler into your server:

```ts
// Bun
Bun.serve({ fetch: handler })

// Deno
Deno.serve(handler)

// Node (with a framework that supports Request/Response)
// e.g. Hono: app.all('/events', (c) => handler(c.req.raw))
```

#### Protocol

The handler exposes a single URL with two modes:

**Query** — `POST` with JSON body:

```
Request:  { address, eventName?, args?, fromBlock?, toBlock? }
Response: { events: [...], fromBlock, toBlock }
```

**Watch** — `GET` with `Accept: text/event-stream` (SSE):

```
: connected
event: change
data: {}
```

The client refetches via POST after each `change` signal. BigInts are serialized as `"__bigint__<value>"` strings automatically.

#### Full example: server + browser client

**Server** (Bun):

```ts
import {
  createIndexer,
  createHttpHandler,
  indexer,
} from '@1001-digital/simple-indexer'
import { createSqliteStore } from '@1001-digital/simple-indexer/sqlite'
import { createPublicClient, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'

const contracts = {
  MyNFT: {
    abi: parseAbi([
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ]),
    address: '0x...',
    startBlock: 12345678n,
    events: { Transfer: async () => {} },
  },
}

const store = createSqliteStore('./data.db')
const client = createPublicClient({ chain: mainnet, transport: http() })
const myIndexer = createIndexer({ client, store, contracts, version: 1 })
await myIndexer.start()

const handler = createHttpHandler({
  source: indexer({ store, contracts }),
  onSubscribe: (listener) => myIndexer.onChange(listener),
  cors: true,
})

Bun.serve({ port: 3001, fetch: handler })
```

**Browser**:

```ts
import { http, createView } from '@1001-digital/simple-indexer'
import { parseAbi } from 'viem'

const source = http({ url: 'http://localhost:3001' })

const view = createView({
  source,
  filter: {
    address: '0x...',
    abi: parseAbi([
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ]),
    eventName: 'Transfer',
  },
  reduce: (events) =>
    events.map((e) => ({
      from: e.args.from,
      to: e.args.to,
      tokenId: e.args.tokenId,
    })),
})

// One-shot
const transfers = await view.get()

// Reactive (re-queries on every server-side change via SSE)
const unsub = view.subscribe((transfers) => {
  renderTransferList(transfers)
})
```

## Acknowledgements

Architectural ideas inspired by [ponder.sh](https://ponder.sh). If you need a full-featured production indexer, check it out.

## License

[MIT](LICENSE)
