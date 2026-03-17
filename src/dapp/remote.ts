import type { Dapp, StoreFilter } from '../types.js'
import { stringify, parse } from '../utils/json.js'

export interface RemoteDappConfig {
  url: string
  fetch?: typeof globalThis.fetch
  EventSource?: typeof globalThis.EventSource
}

export function createRemoteDapp(config: RemoteDappConfig): Dapp {
  const {
    url: baseUrl,
    fetch: fetchFn = globalThis.fetch,
    EventSource: EventSourceCtor = globalThis.EventSource,
  } = config

  // Ensure no trailing slash
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async get(table, key) {
      const res = await fetchFn(`${base}/${table}/${key}`)

      if (res.status === 404) return undefined
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      }

      return parse<Record<string, unknown>>(await res.text())
    },

    async getAll(table, filter?) {
      const body = filter ? stringify(filter) : '{}'
      const res = await fetchFn(`${base}/${table}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      }

      return parse<Record<string, unknown>[]>(await res.text())
    },

    subscribe(fn) {
      const es = new EventSourceCtor(base)

      es.addEventListener('change', (event: MessageEvent) => {
        const data = parse<{ table: string; key: string }>(event.data)
        fn(data.table, data.key)
      })

      return () => {
        es.close()
      }
    },
  }
}
