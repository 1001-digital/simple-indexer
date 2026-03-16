import type { Abi } from 'viem'

/** Describes which events to fetch from a source. */
export interface EventFilter {
  address: `0x${string}` | `0x${string}`[]
  abi: Abi
  eventName?: string
  args?: Record<string, unknown>
  fromBlock?: bigint
  toBlock?: bigint
}

/** A decoded event returned by a source. */
export interface SourceEvent {
  eventName: string
  args: Record<string, unknown>
  address: `0x${string}`
  blockNumber: bigint
  logIndex: number
  transactionHash: `0x${string}`
  blockHash: `0x${string}`
}

/** The result of querying a source. */
export interface SourceResult {
  events: SourceEvent[]
  fromBlock: bigint
  toBlock: bigint
}

/** Thrown when a source cannot serve the requested query. */
export class SourceMiss extends Error {
  constructor(message?: string) {
    super(message ?? 'Source cannot serve this query')
    this.name = 'SourceMiss'
  }
}

/** A queryable event source. */
export interface Source {
  getEvents(filter: EventFilter): Promise<SourceResult>
  watch?(filter: EventFilter, callback: () => void): () => void
}

/** A reactive view over events from a source. */
export interface View<T> {
  get(): Promise<T>
  subscribe(callback: (data: T) => void): () => void
}
