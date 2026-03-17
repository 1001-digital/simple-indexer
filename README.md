# @1001-digital/simple-indexer

Lightweight, reorg-aware EVM indexer that runs in both browser and server contexts. Sync directly from the chain with no indexing service in the middle.

Start in the browser with IndexedDB or on a server with SQLite. Same contracts, handlers, and query code either way.

Its two-layer design keeps a raw event cache separate from derived state, so reindexing happens locally instead of hitting RPC again. Update your handler logic, bump the version, and replay cached events in seconds.

## Features

- **Browser and server** — IndexedDB in the browser, SQLite on the server, in-memory for tests. Switch stores without changing anything else
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

const store = createMemoryStore({
  schema: {
    owners: {
      indexes: [{ name: 'by_owner', fields: ['owner'] }],
    },
  },
})
```

Data lives in memory. Fast, no dependencies, works everywhere. Data is lost when the process exits.

### IndexedDB (browser)

```ts
import { createIdbStore } from '@1001-digital/simple-indexer'

const store = createIdbStore('my-indexer-db', {
  schema: {
    owners: {
      indexes: [{ name: 'by_owner', fields: ['owner'] }],
    },
  },
})
```

Persists across page reloads. Uses a single object store with composite keys to avoid IndexedDB version bumps when new tables appear.

### SQLite (server)

```ts
import { createSqliteStore } from '@1001-digital/simple-indexer/sqlite'

const store = createSqliteStore('./data.db', {
  schema: {
    owners: {
      indexes: [{ name: 'by_owner', fields: ['owner'] }],
    },
  },
})
```

Imported from a separate entry point to avoid bundling `better-sqlite3` in browser builds. Uses WAL mode for performance.

## Config

```ts
createIndexer({
  client, // viem PublicClient
  store, // Store implementation
  contracts: {}, // Contract definitions (see below)
  schema: {}, // Secondary indexes on derived tables (see below)
  version: 1, // Bump to trigger automatic reindex
  pollingInterval: 12_000, // ms between polls (default: 12s)
  finalityDepth: 0, // Blocks behind head to index (default: 0, tip tracking)
  maxChunkSize: 2000, // Max blocks per backfill batch (default: 2000)
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

### Schema (secondary indexes)

Declare indexes on your derived tables to speed up filtered queries. Without an index, `getAll()` with a `where` clause scans every row; with one, it does an exact-match lookup.

```ts
createIndexer({
  client,
  store,
  contracts: {
    NFT: {
      abi: nftAbi,
      address: '0xNFT...',
      startBlock: 12345678n,
      events: {
        Transfer({ event, store }) {
          store.set('transfers', `${event.block}:${event.logIndex}`, {
            tokenId: event.args.tokenId,
            to: event.args.to,
          })
        },
      },
    },
  },
  schema: {
    transfers: {
      indexes: [
        { name: 'by_token', fields: ['tokenId'] },
      ],
    },
  },
  version: 1,
})
```

Query using the index:

```ts
const rows = await indexer.store.getAll('transfers', {
  index: 'by_token',
  where: { tokenId: 42n },
})
```

Indexed queries are strict:

- `index` must name a declared index for that table.
- `where` must include exactly the fields declared by that index.
- If `index` is omitted, `getAll()` falls back to a scan and applies `where` in memory.
- The current implementation only supports exact-match lookups, not ranges.

Compound indexes work the same way — list multiple fields and provide all of them in `where`:

```ts
schema: {
  transfers: {
    indexes: [
      { name: 'by_token_and_to', fields: ['tokenId', 'to'] },
    ],
  },
}

await indexer.store.getAll('transfers', {
  index: 'by_token_and_to',
  where: { tokenId: 42n, to: '0xAlice' },
})
```

Changing the schema (adding, removing, or modifying indexes) triggers an automatic reindex on the next `start()` — cached events are replayed through your handlers, no RPC calls needed.

## How it works

### Two-layer architecture

**Layer 1 — Event cache**: raw decoded events are appended to an internal cache during sync. This cache survives handler logic changes and is never cleared on reindex.

**Layer 2 — Derived state**: the tables your handlers create (`owners`, `transfers`, etc.). These are rebuilt from the event cache when you change handler logic.

### Sync lifecycle

1. **Start** — checks stored version against config; triggers reindex if changed
2. **Backfill** — fetches historical events in chunks from `startBlock` to `head - finalityDepth` (the chain head by default)
3. **Live** — polls for new blocks, fetches events, checks for reorgs

### Reorg handling

Every store write records the previous value in a mutation log. When a reorg is detected:

1. Block hashes are compared against the chain to find the fork point
2. All mutations from the reorged blocks are replayed in reverse
3. Cached events from those blocks are removed
4. Sync resumes from the fork point

The mutation log is pruned once blocks are sufficiently far behind the head.

### Reindex

When you change handler logic, bump the `version` number. On the next `start()`, the indexer will:

1. Clear all derived state (user tables)
2. Replay every cached event through the new handlers
3. No RPC calls needed

The same replay happens automatically when the `schema` changes (e.g. you add or modify an index).

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
| `getAll(table, filter?)`      | Get rows, optionally filtered by `{ where, limit, offset, index }` |
| `set(table, key, value)`      | Create or overwrite a row                                   |
| `update(table, key, partial)` | Merge partial data into an existing row                     |
| `delete(table, key)`          | Remove a row                                                |

## Acknowledgements

Architectural ideas inspired by [ponder.sh](https://ponder.sh). If you need a full-featured production indexer, check it out.

## License

[MIT](LICENSE)
