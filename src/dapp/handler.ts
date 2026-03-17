import type { StoreApi, StoreFilter } from '../types.js'
import { stringify, parse } from '../utils/json.js'

export interface StoreHandlerConfig {
  store: StoreApi
  onSubscribe?: (listener: (table: string, key: string) => void) => () => void
  cors?: boolean | string
}

export function createStoreHandler(
  config: StoreHandlerConfig,
): (req: Request) => Response | Promise<Response> {
  const { store, onSubscribe, cors } = config

  const corsHeaders: Record<string, string> = cors
    ? {
        'Access-Control-Allow-Origin': typeof cors === 'string' ? cors : '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
      }
    : {}

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = new URL(req.url)
    const segments = url.pathname.split('/').filter(Boolean)

    // SSE: GET / with Accept: text/event-stream
    if (
      req.method === 'GET' &&
      req.headers.get('Accept') === 'text/event-stream'
    ) {
      if (!onSubscribe) {
        return new Response('Subscriptions not configured', {
          status: 501,
          headers: corsHeaders,
        })
      }

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(': connected\n\n'))

          const unsubscribe = onSubscribe((table, key) => {
            try {
              controller.enqueue(
                encoder.encode(
                  `event: change\ndata: ${stringify({ table, key })}\n\n`,
                ),
              )
            } catch {
              // Stream closed
            }
          })

          req.signal.addEventListener('abort', () => {
            unsubscribe()
            try {
              controller.close()
            } catch {
              // Already closed
            }
          })
        },
      })

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    // GET /:table/:key — single row
    if (req.method === 'GET' && segments.length === 2) {
      const [table, key] = segments
      try {
        const row = await store.get(table, key)
        if (!row) {
          return new Response('Not found', { status: 404, headers: corsHeaders })
        }
        return new Response(stringify(row), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Internal server error'
        return new Response(message, { status: 500, headers: corsHeaders })
      }
    }

    // POST /:table — filtered query
    if (req.method === 'POST' && segments.length === 1) {
      const [table] = segments
      try {
        const filter = req.headers.get('Content-Length') !== '0'
          ? parse<StoreFilter>(await req.text())
          : undefined
        const rows = await store.getAll(table, filter)
        return new Response(stringify(rows), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Internal server error'
        return new Response(message, { status: 500, headers: corsHeaders })
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders })
  }
}
