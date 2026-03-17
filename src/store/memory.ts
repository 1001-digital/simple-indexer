import type { Store, Mutation, CachedEvent, CachedReceipt } from '../types.js'

interface MemoryRow {
  value: Record<string, unknown>
  block: bigint
  logIndex: number
}

export function createMemoryStore(): Store {
  const tables = new Map<string, Map<string, MemoryRow>>()
  const cursors = new Map<string, bigint>()
  const mutations: Mutation[] = []
  let mutationId = 0
  const events: CachedEvent[] = []
  const receipts = new Map<`0x${string}`, CachedReceipt>()
  const blockHashes = new Map<bigint, string>()
  let version: number | undefined
  let eventFingerprint: string | undefined

  function getTable(name: string): Map<string, MemoryRow> {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)!
  }

  const store: Store = {
    kind: 'memory',
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
      let rows = [...t.values()]
        .sort((a, b) => {
          if (a.block !== b.block) return a.block < b.block ? -1 : 1
          return a.logIndex - b.logIndex
        })
        .map((r) => ({ ...r.value }))

      if (filter?.where) {
        rows = rows.filter((row) =>
          Object.entries(filter.where!).every(([k, v]) => row[k] === v),
        )
      }
      if (filter?.offset) rows = rows.slice(filter.offset)
      if (filter?.limit) rows = rows.slice(0, filter.limit)

      return rows
    },

    async set(table, key, value, block = 0n, logIndex = 0) {
      getTable(table).set(key, { value: { ...value }, block, logIndex })
    },

    async update(table, key, partial, block = 0n, logIndex = 0) {
      const t = getTable(table)
      const existing = t.get(key)
      if (existing) {
        t.set(key, { value: { ...existing.value, ...partial }, block, logIndex })
      }
    },

    async delete(table, key) {
      getTable(table).delete(key)
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
            t.set(m.key, {
              value: { ...m.previous },
              block: m.previousBlock ?? 0n,
              logIndex: m.previousLogIndex ?? 0,
            })
          } else {
            t.delete(m.key)
          }
        } else if (m.op === 'delete') {
          if (m.previous) {
            t.set(m.key, {
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
