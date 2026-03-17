import type { Store, CachedEvent, CachedReceipt } from '../types.js'
import { replacer, reviver } from '../utils/json.js'
import Database from 'better-sqlite3'

export function createSqliteStore(path: string): Store {
  const db = new Database(path)

  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS _data (
      table_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (table_name, key)
    );
    CREATE TABLE IF NOT EXISTS _events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _receipts (
      tx_hash TEXT PRIMARY KEY,
      block INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_block ON _receipts(block);
    CREATE TABLE IF NOT EXISTS _cursors (
      name TEXT PRIMARY KEY,
      block TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _mutations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block INTEGER NOT NULL,
      table_name TEXT NOT NULL,
      key TEXT NOT NULL,
      op TEXT NOT NULL,
      previous_json TEXT
    );
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_block ON _events(block);
    CREATE INDEX IF NOT EXISTS idx_mutations_block ON _mutations(block);
  `)

  const stmts = {
    get: db.prepare(
      'SELECT value_json FROM _data WHERE table_name = ? AND key = ?',
    ),
    getAll: db.prepare('SELECT value_json FROM _data WHERE table_name = ?'),
    set: db.prepare(
      'INSERT OR REPLACE INTO _data (table_name, key, value_json) VALUES (?, ?, ?)',
    ),
    del: db.prepare('DELETE FROM _data WHERE table_name = ? AND key = ?'),
    getCursor: db.prepare('SELECT block FROM _cursors WHERE name = ?'),
    setCursor: db.prepare(
      'INSERT OR REPLACE INTO _cursors (name, block) VALUES (?, ?)',
    ),
    deleteCursor: db.prepare('DELETE FROM _cursors WHERE name = ?'),
    recordMutation: db.prepare(
      'INSERT INTO _mutations (block, table_name, key, op, previous_json) VALUES (?, ?, ?, ?, ?)',
    ),
    getMutationsFrom: db.prepare(
      'SELECT * FROM _mutations WHERE block >= ? ORDER BY id DESC',
    ),
    deleteMutationsFrom: db.prepare('DELETE FROM _mutations WHERE block >= ?'),
    pruneHistory: db.prepare('DELETE FROM _mutations WHERE block < ?'),
    getEvents: db.prepare(
      'SELECT data_json FROM _events ORDER BY block, log_index',
    ),
    getEventsRange: db.prepare(
      'SELECT data_json FROM _events WHERE block >= ? AND block <= ? ORDER BY block, log_index',
    ),
    getEventsFrom: db.prepare(
      'SELECT data_json FROM _events WHERE block >= ? ORDER BY block, log_index',
    ),
    getEventsTo: db.prepare(
      'SELECT data_json FROM _events WHERE block <= ? ORDER BY block, log_index',
    ),
    appendEvent: db.prepare(
      'INSERT INTO _events (block, log_index, data_json) VALUES (?, ?, ?)',
    ),
    removeEventsFrom: db.prepare('DELETE FROM _events WHERE block >= ?'),
    removeEventsRange: db.prepare(
      'DELETE FROM _events WHERE block >= ? AND block <= ?',
    ),
    clearData: db.prepare('DELETE FROM _data'),
    clearMutations: db.prepare('DELETE FROM _mutations'),
    getMeta: db.prepare('SELECT value FROM _meta WHERE key = ?'),
    setMeta: db.prepare(
      'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)',
    ),
    delMeta: db.prepare(
      "DELETE FROM _meta WHERE key LIKE 'blockhash_%' AND CAST(SUBSTR(key, 11) AS INTEGER) >= ?",
    ),
    getReceipt: db.prepare('SELECT data_json FROM _receipts WHERE tx_hash = ?'),
    appendReceipt: db.prepare(
      'INSERT OR REPLACE INTO _receipts (tx_hash, block, data_json) VALUES (?, ?, ?)',
    ),
    removeReceiptsFrom: db.prepare('DELETE FROM _receipts WHERE block >= ?'),
    removeReceiptsRange: db.prepare(
      'DELETE FROM _receipts WHERE block >= ? AND block <= ?',
    ),
  }

  const insertManyEvents = db.transaction((events: CachedEvent[]) => {
    for (const event of events) {
      stmts.appendEvent.run(
        Number(event.block),
        event.logIndex,
        JSON.stringify(event, replacer),
      )
    }
  })

  const insertManyReceipts = db.transaction((receipts: CachedReceipt[]) => {
    for (const r of receipts) {
      stmts.appendReceipt.run(
        r.transactionHash,
        Number(r.blockNumber),
        JSON.stringify(r, replacer),
      )
    }
  })

  const rollbackTx = db.transaction((fromBlock: number) => {
    const mutations = stmts.getMutationsFrom.all(fromBlock) as {
      table_name: string
      key: string
      op: string
      previous_json: string | null
    }[]

    for (const m of mutations) {
      if (m.op === 'set' || m.op === 'update') {
        if (m.previous_json) {
          stmts.set.run(m.table_name, m.key, m.previous_json)
        } else {
          stmts.del.run(m.table_name, m.key)
        }
      } else if (m.op === 'delete') {
        if (m.previous_json) {
          stmts.set.run(m.table_name, m.key, m.previous_json)
        }
      }
    }

    stmts.deleteMutationsFrom.run(fromBlock)
  })

  const store: Store = {
    kind: 'sqlite',
    async get(table, key) {
      const row = stmts.get.get(table, key) as
        | { value_json: string }
        | undefined
      return row ? JSON.parse(row.value_json, reviver) : undefined
    },

    async getAll(table, filter?) {
      let rows = (stmts.getAll.all(table) as { value_json: string }[]).map(
        (r) => JSON.parse(r.value_json, reviver),
      )
      if (filter?.where) {
        rows = rows.filter((row: Record<string, unknown>) =>
          Object.entries(filter.where!).every(([k, v]) => row[k] === v),
        )
      }
      if (filter?.offset) rows = rows.slice(filter.offset)
      if (filter?.limit) rows = rows.slice(0, filter.limit)
      return rows
    },

    async set(table, key, value) {
      stmts.set.run(table, key, JSON.stringify(value, replacer))
    },

    async update(table, key, partial) {
      const row = stmts.get.get(table, key) as
        | { value_json: string }
        | undefined
      if (row) {
        const existing = JSON.parse(row.value_json, reviver)
        stmts.set.run(
          table,
          key,
          JSON.stringify({ ...existing, ...partial }, replacer),
        )
      }
    },

    async delete(table, key) {
      stmts.del.run(table, key)
    },

    async getCursor(name) {
      const row = stmts.getCursor.get(name) as { block: string } | undefined
      return row ? BigInt(row.block) : undefined
    },

    async setCursor(name, block) {
      stmts.setCursor.run(name, block.toString())
    },

    async deleteCursor(name) {
      stmts.deleteCursor.run(name)
    },

    async recordMutation(mutation) {
      stmts.recordMutation.run(
        Number(mutation.block),
        mutation.table,
        mutation.key,
        mutation.op,
        mutation.previous ? JSON.stringify(mutation.previous, replacer) : null,
      )
    },

    async rollback(fromBlock) {
      rollbackTx(Number(fromBlock))
    },

    async pruneHistory(belowBlock) {
      stmts.pruneHistory.run(Number(belowBlock))
    },

    async getEvents(from?, to?) {
      let rows: { data_json: string }[]
      if (from !== undefined && to !== undefined) {
        rows = stmts.getEventsRange.all(Number(from), Number(to)) as {
          data_json: string
        }[]
      } else if (from !== undefined) {
        rows = stmts.getEventsFrom.all(Number(from)) as { data_json: string }[]
      } else if (to !== undefined) {
        rows = stmts.getEventsTo.all(Number(to)) as { data_json: string }[]
      } else {
        rows = stmts.getEvents.all() as { data_json: string }[]
      }
      return rows.map((r) => {
        const e = JSON.parse(r.data_json, reviver)
        e.block = BigInt(e.block)
        return e as CachedEvent
      })
    },

    async appendEvents(events) {
      insertManyEvents(events)
    },

    async removeEventsFrom(block) {
      stmts.removeEventsFrom.run(Number(block))
    },

    async removeEventsRange(from, to) {
      stmts.removeEventsRange.run(Number(from), Number(to))
    },

    async getReceipt(hash) {
      const row = stmts.getReceipt.get(hash) as
        | { data_json: string }
        | undefined
      if (!row) return undefined
      const r = JSON.parse(row.data_json, reviver)
      r.blockNumber = BigInt(r.blockNumber)
      return r as CachedReceipt
    },

    async appendReceipts(receipts) {
      insertManyReceipts(receipts)
    },

    async removeReceiptsFrom(block) {
      stmts.removeReceiptsFrom.run(Number(block))
    },

    async removeReceiptsRange(from, to) {
      stmts.removeReceiptsRange.run(Number(from), Number(to))
    },

    async clearDerivedState() {
      stmts.clearData.run()
      stmts.clearMutations.run()
    },

    async getVersion() {
      const row = stmts.getMeta.get('version') as { value: string } | undefined
      return row ? Number(row.value) : undefined
    },

    async setVersion(v) {
      stmts.setMeta.run('version', v.toString())
    },

    async getEventFingerprint() {
      const row = stmts.getMeta.get('event_fingerprint') as
        | { value: string }
        | undefined
      return row?.value
    },

    async setEventFingerprint(fp) {
      stmts.setMeta.run('event_fingerprint', fp)
    },

    async getBlockHash(block) {
      const row = stmts.getMeta.get(`blockhash_${block}`) as
        | { value: string }
        | undefined
      return row?.value
    },

    async setBlockHash(block, hash) {
      stmts.setMeta.run(`blockhash_${block}`, hash)
    },

    async removeBlockHashesFrom(block) {
      stmts.delMeta.run(Number(block))
    },
  }

  return store
}
