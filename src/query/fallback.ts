import type { Source, EventFilter, SourceResult } from './types.js'
import { SourceMiss } from './types.js'

export interface FallbackConfig {
  /** Auto-reorder sources by observed latency and reliability. */
  rank?: boolean
  /** Retries per source before moving to the next (default 0). */
  retryCount?: number
}

interface SourceState {
  source: Source
  failures: number
  totalTime: number
  calls: number
}

/**
 * Combine multiple sources with automatic failover.
 *
 * Sources are tried in order. On error or SourceMiss, the next source
 * is attempted. With `rank: true`, sources are reordered over time
 * based on observed latency and failure rate.
 */
export function fallback(sources: Source[], config?: FallbackConfig): Source {
  if (sources.length === 0) {
    throw new Error('fallback() requires at least one source')
  }

  const { rank = false, retryCount = 0 } = config ?? {}

  const states: SourceState[] = sources.map((source) => ({
    source,
    failures: 0,
    totalTime: 0,
    calls: 0,
  }))

  let ranked: SourceState[] | undefined

  function getOrderedStates(): SourceState[] {
    if (!rank) return states

    if (!ranked) {
      ranked = [...states].sort((a, b) => {
        // Penalize failures heavily, then sort by average latency
        const scoreA =
          a.calls > 0 ? a.totalTime / a.calls + a.failures * 1000 : 0
        const scoreB =
          b.calls > 0 ? b.totalTime / b.calls + b.failures * 1000 : 0
        return scoreA - scoreB
      })
    }

    return ranked
  }

  function invalidateRanking() {
    ranked = undefined
  }

  return {
    async getEvents(filter: EventFilter): Promise<SourceResult> {
      const ordered = getOrderedStates()
      let lastError: Error | undefined

      for (const state of ordered) {
        for (let attempt = 0; attempt <= retryCount; attempt++) {
          try {
            const start = rank ? Date.now() : 0
            const result = await state.source.getEvents(filter)

            if (rank) {
              state.totalTime += Date.now() - start
              state.calls++
              invalidateRanking()
            }

            return result
          } catch (error) {
            const err =
              error instanceof Error ? error : new Error(String(error))

            if (error instanceof SourceMiss) {
              // Don't retry misses — source definitively can't serve this
              lastError = err
              break
            }

            if (rank) {
              state.failures++
              invalidateRanking()
            }

            lastError = err
          }
        }
      }

      throw lastError ?? new Error('All sources exhausted')
    },

    watch(filter: EventFilter, callback: () => void): () => void {
      const ordered = getOrderedStates()

      for (const state of ordered) {
        if (!state.source.watch) continue

        try {
          return state.source.watch(filter, callback)
        } catch {
          continue
        }
      }

      throw new Error('No source supports watching')
    },
  }
}
