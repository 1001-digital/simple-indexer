import type { Abi, PublicClient } from 'viem'

// --- Store primitives ---

export interface Mutation {
  id: number
  block: bigint
  table: string
  key: string
  op: 'set' | 'update' | 'delete'
  previous: Record<string, unknown> | undefined
}

export interface CachedEvent {
  block: bigint
  logIndex: number
  contractName: string
  eventName: string
  args: Record<string, unknown>
  address: `0x${string}`
  transactionHash: `0x${string}`
  blockHash: `0x${string}`
}

export interface StoreFilter {
  where?: Record<string, unknown>
  limit?: number
  offset?: number
}

// --- Store (internal, full interface) ---

export interface Store {
  get(table: string, key: string): Promise<Record<string, unknown> | undefined>
  getAll(
    table: string,
    filter?: StoreFilter,
  ): Promise<Record<string, unknown>[]>
  set(table: string, key: string, value: Record<string, unknown>): Promise<void>
  update(
    table: string,
    key: string,
    partial: Record<string, unknown>,
  ): Promise<void>
  delete(table: string, key: string): Promise<void>

  getCursor(name: string): Promise<bigint | undefined>
  setCursor(name: string, block: bigint): Promise<void>

  recordMutation(mutation: Omit<Mutation, 'id'>): Promise<void>
  rollback(fromBlock: bigint): Promise<void>
  pruneHistory(belowBlock: bigint): Promise<void>

  getEvents(from?: bigint, to?: bigint): Promise<CachedEvent[]>
  appendEvents(events: CachedEvent[]): Promise<void>
  removeEventsFrom(block: bigint): Promise<void>

  clearDerivedState(): Promise<void>

  getVersion(): Promise<number | undefined>
  setVersion(v: number): Promise<void>

  getBlockHash(block: bigint): Promise<string | undefined>
  setBlockHash(block: bigint, hash: string): Promise<void>
  removeBlockHashesFrom(block: bigint): Promise<void>
}

// --- StoreApi (what event handlers see) ---

export interface StoreApi {
  get(table: string, key: string): Promise<Record<string, unknown> | undefined>
  getAll(
    table: string,
    filter?: StoreFilter,
  ): Promise<Record<string, unknown>[]>
  set(table: string, key: string, value: Record<string, unknown>): Promise<void>
  update(
    table: string,
    key: string,
    partial: Record<string, unknown>,
  ): Promise<void>
  delete(table: string, key: string): Promise<void>
}

// --- Event handler ---

export interface EventHandlerContext {
  event: {
    name: string
    args: Record<string, unknown>
    address: `0x${string}`
    block: bigint
    logIndex: number
    transactionHash: `0x${string}`
    blockHash: `0x${string}`
  }
  store: StoreApi
}

export type EventHandler = (ctx: EventHandlerContext) => void | Promise<void>

// --- Config ---

export interface ContractConfig {
  abi: Abi
  address: `0x${string}` | `0x${string}`[]
  startBlock?: bigint
  endBlock?: bigint
  events: Record<string, EventHandler>
}

export interface IndexerConfig {
  client: PublicClient
  store: Store
  contracts: Record<string, ContractConfig>
  version?: number
  pollingInterval?: number
  finalityDepth?: number
  chunkSize?: number
}

export interface ChunkInfo {
  phase: 'backfill' | 'live'
  from: bigint
  to: bigint
  size: number
  eventCount: number
}

// --- Indexer instance ---

export type IndexerPhase =
  | 'idle'
  | 'backfilling'
  | 'live'
  | 'reindexing'
  | 'error'

export interface IndexerStatus {
  phase: IndexerPhase
  startBlock: bigint
  currentBlock: bigint
  latestBlock: bigint
  progress: number
  error?: Error
}

export interface Indexer {
  start(): Promise<void>
  stop(): void
  reindex(): Promise<void>
  store: StoreApi
  status: IndexerStatus
  onStatus(fn: (status: IndexerStatus) => void): () => void
  onChange(fn: (table: string, key: string) => void): () => void
  onChunk(fn: (chunk: ChunkInfo) => void): () => void
}
