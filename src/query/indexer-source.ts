import type { Store, ContractConfig } from '../types.js'
import type { Source, EventFilter, SourceResult, SourceEvent } from './types.js'
import { SourceMiss } from './types.js'
import { toArray } from './utils.js'

export interface IndexerSourceConfig {
  store: Store
  contracts?: Record<string, ContractConfig>
  onUpdate?: (fn: () => void) => () => void
}

function matchesAddress(
  eventAddress: `0x${string}`,
  filterAddress: `0x${string}` | `0x${string}`[],
): boolean {
  return toArray(filterAddress).some(
    (a) => a.toLowerCase() === eventAddress.toLowerCase(),
  )
}

function matchesArgs(
  eventArgs: Record<string, unknown>,
  filterArgs: Record<string, unknown>,
): boolean {
  return Object.entries(filterArgs).every(([key, value]) => {
    const eventValue = eventArgs[key]

    if (typeof value === 'bigint' && typeof eventValue === 'bigint') {
      return value === eventValue
    }

    // Case-insensitive address comparison
    if (typeof value === 'string' && typeof eventValue === 'string') {
      return value.toLowerCase() === eventValue.toLowerCase()
    }

    return eventValue === value
  })
}

/**
 * Check whether the indexer's config covers the requested filter.
 * Returns true if every requested address+event is handled.
 */
function checkCoverage(
  contracts: Record<string, ContractConfig>,
  filter: EventFilter,
): boolean {
  for (const addr of toArray(filter.address)) {
    let covered = false

    for (const contract of Object.values(contracts)) {
      const addressMatch = toArray(contract.address).some(
        (a) => a.toLowerCase() === addr.toLowerCase(),
      )
      if (!addressMatch) continue

      if (filter.eventName && !contract.events[filter.eventName]) continue

      covered = true
      break
    }

    if (!covered) return false
  }

  return true
}

/**
 * Create a source that reads from an indexer's event cache.
 *
 * Pass `contracts` so the source can detect when it can't serve a query
 * and throw SourceMiss (letting a fallback try the next source).
 *
 * Pass `onUpdate` to enable `watch()` — typically wired to the indexer's
 * status or change events.
 */
export function indexer(config: IndexerSourceConfig): Source {
  const { store, contracts, onUpdate } = config

  const source: Source = {
    async getEvents(filter: EventFilter): Promise<SourceResult> {
      if (contracts && !checkCoverage(contracts, filter)) {
        throw new SourceMiss('Indexer does not cover the requested events')
      }

      const cursor = await store.getCursor('_indexer')
      if (cursor === undefined) {
        throw new SourceMiss('Indexer has not started syncing')
      }

      const fromBlock = filter.fromBlock ?? 0n
      const toBlock = filter.toBlock !== undefined
        ? (filter.toBlock < cursor ? filter.toBlock : cursor)
        : cursor

      const cached = await store.getEvents(fromBlock, toBlock)

      const events: SourceEvent[] = []
      for (const e of cached) {
        if (!matchesAddress(e.address, filter.address)) continue
        if (filter.eventName && e.eventName !== filter.eventName) continue
        if (filter.args && !matchesArgs(e.args, filter.args)) continue

        events.push({
          eventName: e.eventName,
          args: e.args,
          address: e.address,
          blockNumber: e.block,
          logIndex: e.logIndex,
          transactionHash: e.transactionHash,
          blockHash: e.blockHash,
        })
      }

      return { events, fromBlock, toBlock: cursor }
    },
  }

  if (onUpdate) {
    source.watch = (_filter: EventFilter, callback: () => void) => {
      return onUpdate(callback)
    }
  }

  return source
}
