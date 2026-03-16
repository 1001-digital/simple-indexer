import type { Source, EventFilter, SourceResult } from './types.js'
import { SourceMiss } from './types.js'
import { stringify, parse } from '../utils/json.js'

export interface HttpSourceConfig {
  url: string
  fetch?: typeof globalThis.fetch
  EventSource?: typeof globalThis.EventSource
}

export function http(config: HttpSourceConfig): Source {
  const {
    url,
    fetch: fetchFn = globalThis.fetch,
    EventSource: EventSourceCtor = globalThis.EventSource,
  } = config

  const source: Source = {
    async getEvents(filter: EventFilter): Promise<SourceResult> {
      // Strip abi — server already has decoded events
      const { abi: _, ...body } = filter

      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        if (res.status === 404) throw new SourceMiss(text)
        throw new Error(`HTTP ${res.status}: ${text}`)
      }

      return parse<SourceResult>(await res.text())
    },

    watch(_filter: EventFilter, callback: () => void): () => void {
      const es = new EventSourceCtor(url)

      es.addEventListener('change', () => {
        callback()
      })

      return () => {
        es.close()
      }
    },
  }

  return source
}
