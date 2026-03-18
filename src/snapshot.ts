import type { Store, CachedEvent } from './types.js'
import { replacer, reviver } from './utils/json.js'

const BATCH_SIZE = 1000
const SNAPSHOT_VERSION = 1

interface SnapshotHeader {
  type: 'header'
  version: number
  eventFingerprint: string | undefined
  from: bigint | undefined
  to: bigint | undefined
}

interface SnapshotEvents {
  type: 'events'
  events: CachedEvent[]
}

interface SnapshotCursors {
  type: 'cursors'
  entries: [string, bigint][]
}

interface SnapshotBlockHashes {
  type: 'blockHashes'
  entries: [bigint, string][]
}

type SnapshotLine = SnapshotHeader | SnapshotEvents | SnapshotCursors | SnapshotBlockHashes

export function exportSnapshot(store: Store): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  function encode(line: SnapshotLine): Uint8Array {
    return encoder.encode(JSON.stringify(line, replacer) + '\n')
  }

  let events: CachedEvent[]
  let phase: 'header' | 'events' | 'cursors' | 'blockHashes' | 'done' = 'header'
  let eventOffset = 0

  return new ReadableStream<Uint8Array>({
    async start() {
      events = await store.getEvents()
    },

    async pull(controller) {
      if (phase === 'header') {
        const fp = await store.getEventFingerprint()
        const from = events.length > 0 ? events[0].block : undefined
        const to = events.length > 0 ? events[events.length - 1].block : undefined
        controller.enqueue(encode({ type: 'header', version: SNAPSHOT_VERSION, eventFingerprint: fp, from, to }))
        phase = 'events'
        return
      }

      if (phase === 'events') {
        if (eventOffset < events.length) {
          const batch = events.slice(eventOffset, eventOffset + BATCH_SIZE)
          eventOffset += BATCH_SIZE
          controller.enqueue(encode({ type: 'events', events: batch }))
          return
        }
        phase = 'cursors'
      }

      if (phase === 'cursors') {
        const cursors = store.getAllCursors
          ? await store.getAllCursors()
          : new Map<string, bigint>()
        controller.enqueue(encode({ type: 'cursors', entries: [...cursors.entries()] }))
        phase = 'blockHashes'
        return
      }

      if (phase === 'blockHashes') {
        const hashes = store.getAllBlockHashes
          ? await store.getAllBlockHashes()
          : new Map<bigint, string>()
        controller.enqueue(encode({ type: 'blockHashes', entries: [...hashes.entries()] }))
        phase = 'done'
        controller.close()
      }
    },
  })
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines) {
        if (line) yield line
      }
    }
    // Flush remaining
    buffer += decoder.decode()
    if (buffer) yield buffer
  } finally {
    reader.releaseLock()
  }
}

export async function importSnapshot(store: Store, stream: ReadableStream<Uint8Array>): Promise<void> {
  // Clear all existing data
  await store.clearDerivedState()
  // Clear events
  await store.removeEventsFrom(0n)
  // Clear block hashes
  await store.removeBlockHashesFrom(0n)

  for await (const line of readLines(stream)) {
    const parsed = JSON.parse(line, reviver) as SnapshotLine

    switch (parsed.type) {
      case 'header': {
        if (parsed.version !== SNAPSHOT_VERSION) {
          throw new Error(`Unsupported snapshot version: ${parsed.version}`)
        }
        if (parsed.eventFingerprint !== undefined) {
          await store.setEventFingerprint(parsed.eventFingerprint)
        }
        break
      }
      case 'events': {
        await store.appendEvents(parsed.events)
        break
      }
      case 'cursors': {
        for (const [name, block] of parsed.entries) {
          await store.setCursor(name, block)
        }
        break
      }
      case 'blockHashes': {
        for (const [block, hash] of parsed.entries) {
          await store.setBlockHash(block, hash)
        }
        break
      }
    }
  }
}
