import type { Store, Mutation, CachedEvent, CachedReceipt, IndexerSchema } from '../types.js'
import {
  encodeIndexKey,
  getIndexSchema,
  getTableIndexes,
  indexMatchesWhere,
  normalizeSchema,
  type NormalizedIndexerSchema,
} from './indexing.js'

interface MemoryRow {
  value: Record<string, unknown>
  block: bigint
  logIndex: number
}

interface MemoryStoreOptions {
  schema?: IndexerSchema
}

export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  const tables = new Map<string, Map<string, MemoryRow>>()
  const indexRows = new Map<string, Map<string, Map<string, Set<string>>>>()
  const cursors = new Map<string, bigint>()
  const mutations: Mutation[] = []
  let mutationId = 0
  const events: CachedEvent[] = []
  const receipts = new Map<`0x${string}`, CachedReceipt>()
  const blockHashes = new Map<bigint, string>()
  let version: number | undefined
  let eventFingerprint: string | undefined
  let schemaFingerprint: string | undefined
  let schema: NormalizedIndexerSchema = normalizeSchema(options.schema)

  function getTable(name: string): Map<string, MemoryRow> {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)!
  }

  function getTableIndexMap(name: string): Map<string, Map<string, Set<string>>> {
    if (!indexRows.has(name)) indexRows.set(name, new Map())
    return indexRows.get(name)!
  }

  function removeIndexEntries(table: string, key: string, row?: MemoryRow) {
    const indexMap = indexRows.get(table)
    if (!indexMap || !row) return

    for (const index of getTableIndexes(schema, table)) {
      const indexKey = encodeIndexKey(index, row.value)
      const bucket = indexMap.get(index.name)?.get(indexKey)
      if (!bucket) continue
      bucket.delete(key)
      if (bucket.size === 0) {
        indexMap.get(index.name)!.delete(indexKey)
      }
    }
  }

  function addIndexEntries(table: string, key: string, row: MemoryRow) {
    const indexes = getTableIndexes(schema, table)
    if (!indexes.length) return

    const indexMap = getTableIndexMap(table)
    for (const index of indexes) {
      const indexKey = encodeIndexKey(index, row.value)
      if (!indexMap.has(index.name)) indexMap.set(index.name, new Map())
      const values = indexMap.get(index.name)!
      if (!values.has(indexKey)) values.set(indexKey, new Set())
      values.get(indexKey)!.add(key)
    }
  }

  function writeRow(table: string, key: string, row: MemoryRow) {
    const t = getTable(table)
    const previous = t.get(key)
    if (previous) removeIndexEntries(table, key, previous)
    t.set(key, row)
    addIndexEntries(table, key, row)
  }

  function deleteRow(table: string, key: string) {
    const t = getTable(table)
    const previous = t.get(key)
    if (previous) removeIndexEntries(table, key, previous)
    t.delete(key)
  }

  function rebuildIndexes() {
    indexRows.clear()
    for (const [table, rows] of tables) {
      if (table.startsWith('_')) continue
      for (const [key, row] of rows) {
        addIndexEntries(table, key, row)
      }
    }
  }

  const store: Store = {
    kind: 'memory',
    configureSchema(nextSchema) {
      schema = normalizeSchema(nextSchema)
      rebuildIndexes()
    },

    async get(table, key) {
      const row = getTable(table).get(key)
      return row ? { ...row.value } : undefined
    },

    async getEntry(table, key) {
      const row = getTable(table).get(key)
      return row ? { value: { ...row.value }, block: row.block, logIndex: row.logIndex } : undefined
    },

    async getAll(table, filter?) {
      const t = getTable(table)
      let rows = [...t.entries()]
        .map(([key, row]) => ({ key, row }))
      if (filter?.index) {
        const index = getIndexSchema(schema, table, filter.index)
        if (!index) {
          throw new Error(`Index "${filter.index}" is not declared for table "${table}"`)
        }
        if (!indexMatchesWhere(index, filter.where)) {
          throw new Error(
            `Indexed query on "${table}" must provide exactly these fields: ${index.fields.join(', ')}`,
          )
        }
        const indexKey = encodeIndexKey(index, filter.where!)
        const keys = getTableIndexMap(table).get(index.name)?.get(indexKey) ?? new Set<string>()
        rows = [...keys].map((key) => ({ key, row: t.get(key)! })).filter((entry) => entry.row)
      }

      let values = rows
        .sort((a, b) => {
          if (a.row.block !== b.row.block) return a.row.block < b.row.block ? -1 : 1
          return a.row.logIndex - b.row.logIndex
        })
        .map((entry) => ({ ...entry.row.value }))

      if (filter?.where && !filter.index) {
        values = values.filter((row) =>
          Object.entries(filter.where!).every(([k, v]) => row[k] === v),
        )
      }
      if (filter?.offset) values = values.slice(filter.offset)
      if (filter?.limit) values = values.slice(0, filter.limit)

      return values
    },

    async set(table, key, value, block = 0n, logIndex = 0) {
      writeRow(table, key, { value: { ...value }, block, logIndex })
    },

    async update(table, key, partial, block = 0n, logIndex = 0) {
      const t = getTable(table)
      const existing = t.get(key)
      if (existing) {
        writeRow(table, key, {
          value: { ...existing.value, ...partial },
          block,
          logIndex,
        })
      }
    },

    async delete(table, key) {
      deleteRow(table, key)
    },

    async getCursor(name) {
      return cursors.get(name)
    },

    async setCursor(name, block) {
      cursors.set(name, block)
    },

    async deleteCursor(name) {
      cursors.delete(name)
    },

    async recordMutation(mutation) {
      mutations.push({ ...mutation, id: ++mutationId })
    },

    async rollback(fromBlock) {
      for (let i = mutations.length - 1; i >= 0; i--) {
        const m = mutations[i]
        if (m.block < fromBlock) break

        const t = getTable(m.table)
        if (m.op === 'set' || m.op === 'update') {
          if (m.previous) {
            writeRow(m.table, m.key, {
              value: { ...m.previous },
              block: m.previousBlock ?? 0n,
              logIndex: m.previousLogIndex ?? 0,
            })
          } else {
            deleteRow(m.table, m.key)
          }
        } else if (m.op === 'delete') {
          if (m.previous) {
            writeRow(m.table, m.key, {
              value: { ...m.previous },
              block: m.previousBlock ?? 0n,
              logIndex: m.previousLogIndex ?? 0,
            })
          }
        }
      }

      // Remove rolled-back mutations
      let idx = mutations.length
      while (idx > 0 && mutations[idx - 1].block >= fromBlock) idx--
      mutations.length = idx
    },

    async pruneHistory(belowBlock) {
      let idx = 0
      while (idx < mutations.length && mutations[idx].block < belowBlock) idx++
      if (idx > 0) mutations.splice(0, idx)
    },

    async getEvents(from?, to?) {
      return events.filter((e) => {
        if (from !== undefined && e.block < from) return false
        if (to !== undefined && e.block > to) return false
        return true
      })
    },

    async appendEvents(newEvents) {
      events.push(...newEvents)
    },

    async removeEventsFrom(block) {
      let idx = events.length
      while (idx > 0 && events[idx - 1].block >= block) idx--
      events.length = idx
    },

    async removeEventsRange(from, to) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].block >= from && events[i].block <= to) {
          events.splice(i, 1)
        }
      }
    },

    async getReceipt(hash) {
      return receipts.get(hash)
    },

    async appendReceipts(newReceipts) {
      for (const r of newReceipts) {
        receipts.set(r.transactionHash, r)
      }
    },

    async removeReceiptsFrom(block) {
      for (const [hash, r] of receipts) {
        if (r.blockNumber >= block) receipts.delete(hash)
      }
    },

    async removeReceiptsRange(from, to) {
      for (const [hash, r] of receipts) {
        if (r.blockNumber >= from && r.blockNumber <= to) receipts.delete(hash)
      }
    },

    async clearDerivedState() {
      for (const name of [...tables.keys()]) {
        if (!name.startsWith('_')) {
          tables.delete(name)
        }
      }
      indexRows.clear()
      mutations.length = 0
      mutationId = 0
    },

    async getVersion() {
      return version
    },

    async setVersion(v) {
      version = v
    },

    async getEventFingerprint() {
      return eventFingerprint
    },

    async setEventFingerprint(fp) {
      eventFingerprint = fp
    },

    async getSchemaFingerprint() {
      return schemaFingerprint
    },

    async setSchemaFingerprint(fp) {
      schemaFingerprint = fp
    },

    async getBlockHash(block) {
      return blockHashes.get(block)
    },

    async setBlockHash(block, hash) {
      blockHashes.set(block, hash)
    },

    async removeBlockHashesFrom(block) {
      for (const b of [...blockHashes.keys()]) {
        if (b >= block) blockHashes.delete(b)
      }
    },
  }

  return store
}
