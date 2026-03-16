import type { Source, EventFilter, SourceEvent, View } from './types.js'

export interface ViewConfig<T> {
  source: Source
  filter: EventFilter
  reduce: (events: SourceEvent[]) => T
}

/**
 * Create a reactive view over events from a source.
 *
 * A view combines an event filter with a reduce function.
 * Call `get()` for one-shot queries, or `subscribe()` for
 * reactive updates when the source's data changes.
 */
export function createView<T>(config: ViewConfig<T>): View<T> {
  const { source, filter, reduce } = config

  return {
    async get(): Promise<T> {
      const result = await source.getEvents(filter)
      return reduce(result.events)
    },

    subscribe(callback: (data: T) => void): () => void {
      if (!source.watch) {
        throw new Error(
          'Source does not support watching — use get() for one-shot queries',
        )
      }

      let active = true

      function refetch() {
        source.getEvents(filter).then(
          (result) => {
            if (active) callback(reduce(result.events))
          },
          () => {
            // Silently ignore fetch errors in subscribe — the next
            // watch trigger will retry.
          },
        )
      }

      // Initial fetch
      refetch()

      // Watch for changes and re-query
      const unwatch = source.watch(filter, () => {
        if (active) refetch()
      })

      return () => {
        active = false
        unwatch()
      }
    },
  }
}
