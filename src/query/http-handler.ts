import type { Source, EventFilter } from './types.js'
import { SourceMiss } from './types.js'
import { stringify, parse } from '../utils/json.js'

export interface HttpHandlerConfig {
  source: Source
  /** Subscribe to data changes — required for SSE watch support. */
  onSubscribe?: (listener: () => void) => () => void
  /** Enable CORS. `true` = allow all origins, or pass an origin string. */
  cors?: boolean | string
}

export function createHttpHandler(
  config: HttpHandlerConfig,
): (req: Request) => Response | Promise<Response> {
  const { source, onSubscribe, cors } = config

  const headers: Record<string, string> = cors
    ? {
        'Access-Control-Allow-Origin': typeof cors === 'string' ? cors : '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
      }
    : {}

  return async (req: Request): Promise<Response> => {

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }

    // SSE watch
    if (
      req.method === 'GET' &&
      req.headers.get('Accept') === 'text/event-stream'
    ) {
      if (!onSubscribe) {
        return new Response('Watch not configured', {
          status: 501,
          headers,
        })
      }

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          controller.enqueue(encoder.encode(': connected\n\n'))

          const unsubscribe = onSubscribe(() => {
            try {
              controller.enqueue(
                encoder.encode('event: change\ndata: {}\n\n'),
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
          ...headers,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    // Query
    if (req.method === 'POST') {
      try {
        const body = parse<Omit<EventFilter, 'abi'>>(await req.text())
        const filter: EventFilter = { ...body, abi: [] }
        const result = await source.getEvents(filter)
        return new Response(stringify(result), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        })
      } catch (error) {
        if (error instanceof SourceMiss) {
          return new Response(error.message, { status: 404, headers })
        }
        const message =
          error instanceof Error ? error.message : 'Internal server error'
        return new Response(message, { status: 500, headers })
      }
    }

    return new Response('Method not allowed', { status: 405, headers })
  }
}
