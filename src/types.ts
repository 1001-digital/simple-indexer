import type { Abi, PublicClient } from 'viem'

// --- Store primitives ---

export interface Mutation {
  id: number
  block: bigint
  table: string
  key: string
  op: 'set' | 'update' | 'delete'
  previous: Record<string, unknown> | undefined
  previousBlock?: bigint
  previousLogIndex?: number
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
  receipt?: CachedReceipt
}

export interface CachedReceiptLog {
  address: `0x${string}`
  topics: [`0x${string}`, ...`0x${string}`[]]
  data: `0x${string}`
  logIndex: number
}

export interface CachedReceipt {
  transactionHash: `0x${string}`
  blockNumber: bigint
  logs: CachedReceiptLog[]
}

export interface StoreFilter {
  where?: Record<string, unknown>
  limit?: number
  offset?: number
  index?: string
}

export interface TableIndexSchema {
  name: string
  fields: string[]
}

export interface TableSchema {
  indexes?: TableIndexSchema[]
}

export type IndexerSchema = Record<string, TableSchema>

// --- Store (internal, full interface) ---

export interface Store {
  readonly kind?: 'memory' | 'sqlite' | 'idb'
  configureSchema?(schema: IndexerSchema): Promise<void> | void
  rebuildIndexes?(): Promise<void> | void
  get(table: string, key: string): Promise<Record<string, unknown> | undefined>
  getEntry(table: string, key: string): Promise<{ value: Record<string, unknown>; block: bigint; logIndex: number } | undefined>
  getAll(
    table: string,
    filter?: StoreFilter,
  ): Promise<Record<string, unknown>[]>
  set(table: string, key: string, value: Record<string, unknown>, block?: bigint, logIndex?: number): Promise<void>
  update(
    table: string,
    key: string,
    partial: Record<string, unknown>,
    block?: bigint,
    logIndex?: number,
  ): Promise<void>
  delete(table: string, key: string): Promise<void>

  getCursor(name: string): Promise<bigint | undefined>
  setCursor(name: string, block: bigint): Promise<void>
  deleteCursor(name: string): Promise<void>

  recordMutation(mutation: Omit<Mutation, 'id'>): Promise<void>
  rollback(fromBlock: bigint): Promise<void>
  pruneHistory(belowBlock: bigint): Promise<void>

  getEvents(from?: bigint, to?: bigint): Promise<CachedEvent[]>
  appendEvents(events: CachedEvent[]): Promise<void>
  removeEventsFrom(block: bigint): Promise<void>
  removeEventsRange(from: bigint, to: bigint): Promise<void>

  clearDerivedState(): Promise<void>

  getVersion(): Promise<number | undefined>
  setVersion(v: number): Promise<void>

  getEventFingerprint(): Promise<string | undefined>
  setEventFingerprint(fp: string): Promise<void>

  getSchemaFingerprint?(): Promise<string | undefined>
  setSchemaFingerprint?(fp: string): Promise<void>

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
    receipt?: CachedReceipt
  }
  store: StoreApi
}

export type EventHandler = (ctx: EventHandlerContext) => void | Promise<void>

export interface EventWithArgs {
  args: Record<string, unknown>
  handler: EventHandler
}

export type EventConfig = EventHandler | EventWithArgs

export function getEventHandler(config: EventConfig): EventHandler {
  return typeof config === 'function' ? config : config.handler
}

export function getEventArgs(config: EventConfig): Record<string, unknown> | undefined {
  return typeof config === 'function' ? undefined : config.args
}

// --- Config ---

export interface ContractConfig {
  abi: Abi
  address: `0x${string}` | `0x${string}`[]
  startBlock?: bigint
  endBlock?: bigint
  includeTransactionReceipts?: boolean
  events: Record<string, EventConfig>
}

// --- Logger ---

export interface IndexerLogger {
  onStatus?: (status: IndexerStatus) => void
  onChunk?: (chunk: ChunkInfo) => void
  onError?: (error: unknown) => void
}

export type LogOption = boolean | IndexerLogger

export interface IndexerConfig {
  client: PublicClient
  store: Store
  contracts: Record<string, ContractConfig>
  schema?: IndexerSchema
  version?: number
  pollingInterval?: number
  finalityDepth?: number
  maxChunkSize?: number
  name?: string
  log?: LogOption
}

export interface ChunkInfo {
  phase: 'backfill' | 'live' | 'gap-fill'
  from: bigint
  to: bigint
  size: number
  eventCount: number
  cached?: boolean
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
  cachedBlocks?: number
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

