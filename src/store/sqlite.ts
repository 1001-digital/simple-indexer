import type { Store, CachedEvent, CachedReceipt, IndexerSchema } from '../types.js'
import { replacer, reviver } from '../utils/json.js'
import Database from 'better-sqlite3'
import {
  encodeIndexKey,
  getIndexSchema,
  getTableIndexes,
  indexMatchesWhere,
  normalizeSchema,
  type NormalizedIndexerSchema,
} from './indexing.js'

interface SqliteStoreOptions {
  schema?: IndexerSchema
}

export function createSqliteStore(path: string, options: SqliteStoreOptions = {}): Store {
  const db = new Database(path)
  let schema: NormalizedIndexerSchema = normalizeSchema(options.schema)

  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS _data (
      table_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      block INTEGER NOT NULL DEFAULT 0,
      log_index INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (table_name, key)
    );
    CREATE TABLE IF NOT EXISTS _index_data (
      table_name TEXT NOT NULL,
      index_name TEXT NOT NULL,
      index_key TEXT NOT NULL,
      row_key TEXT NOT NULL,
      block INTEGER NOT NULL DEFAULT 0,
      log_index INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (table_name, index_name, index_key, row_key)
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
      previous_json TEXT,
      previous_block INTEGER,
      previous_log_index INTEGER
    );
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_data_block_log ON _data(table_name, block, log_index);
    CREATE INDEX IF NOT EXISTS idx_index_lookup ON _index_data(table_name, index_name, index_key, block, log_index);
    CREATE INDEX IF NOT EXISTS idx_events_block ON _events(block);
    CREATE INDEX IF NOT EXISTS idx_mutations_block ON _mutations(block);
  `)

  // Migrate existing databases: add columns if missing
  const dataColumns = (db.pragma('table_info(_data)') as { name: string }[]).map((c) => c.name)
  if (!dataColumns.includes('block')) {
    db.exec('ALTER TABLE _data ADD COLUMN block INTEGER NOT NULL DEFAULT 0')
  }
  if (!dataColumns.includes('log_index')) {
    db.exec('ALTER TABLE _data ADD COLUMN log_index INTEGER NOT NULL DEFAULT 0')
  }
  const mutColumns = (db.pragma('table_info(_mutations)') as { name: string }[]).map((c) => c.name)
  if (!mutColumns.includes('previous_block')) {
    db.exec('ALTER TABLE _mutations ADD COLUMN previous_block INTEGER')
  }
  if (!mutColumns.includes('previous_log_index')) {
    db.exec('ALTER TABLE _mutations ADD COLUMN previous_log_index INTEGER')
  }

  const stmts = {
    get: db.prepare(
      'SELECT value_json FROM _data WHERE table_name = ? AND key = ?',
    ),
    getEntry: db.prepare(
      'SELECT value_json, block, log_index FROM _data WHERE table_name = ? AND key = ?',
    ),
    getAllDataEntries: db.prepare(
      'SELECT table_name, key, value_json, block, log_index FROM _data',
    ),
    getAll: db.prepare('SELECT value_json FROM _data WHERE table_name = ? ORDER BY block ASC, log_index ASC'),
    getAllIndexed: db.prepare(`
      SELECT d.value_json
      FROM _index_data i
      JOIN _data d
        ON d.table_name = i.table_name
       AND d.key = i.row_key
      WHERE i.table_name = ?
        AND i.index_name = ?
        AND i.index_key = ?
      ORDER BY i.block ASC, i.log_index ASC
    `),
    set: db.prepare(
      'INSERT OR REPLACE INTO _data (table_name, key, value_json, block, log_index) VALUES (?, ?, ?, ?, ?)',
    ),
    del: db.prepare('DELETE FROM _data WHERE table_name = ? AND key = ?'),
    insertIndex: db.prepare(
      'INSERT OR REPLACE INTO _index_data (table_name, index_name, index_key, row_key, block, log_index) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    deleteIndexRowsForKey: db.prepare(
      'DELETE FROM _index_data WHERE table_name = ? AND row_key = ?',
    ),
    getCursor: db.prepare('SELECT block FROM _cursors WHERE name = ?'),
    setCursor: db.prepare(
      'INSERT OR REPLACE INTO _cursors (name, block) VALUES (?, ?)',
    ),
    deleteCursor: db.prepare('DELETE FROM _cursors WHERE name = ?'),
    recordMutation: db.prepare(
      'INSERT INTO _mutations (block, table_name, key, op, previous_json, previous_block, previous_log_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
    clearIndexes: db.prepare('DELETE FROM _index_data'),
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
      previous_block: number | null
      previous_log_index: number | null
    }[]

    for (const m of mutations) {
      if (m.op === 'set' || m.op === 'update') {
        if (m.previous_json) {
          writeRow(
            m.table_name,
            m.key,
            JSON.parse(m.previous_json, reviver),
            BigInt(m.previous_block ?? 0),
            m.previous_log_index ?? 0,
          )
        } else {
          deleteRow(m.table_name, m.key)
        }
      } else if (m.op === 'delete') {
        if (m.previous_json) {
          writeRow(
            m.table_name,
            m.key,
            JSON.parse(m.previous_json, reviver),
            BigInt(m.previous_block ?? 0),
            m.previous_log_index ?? 0,
          )
        }
      }
    }

    stmts.deleteMutationsFrom.run(fromBlock)
  })

  function replaceIndexEntries(
    table: string,
    key: string,
    value: Record<string, unknown>,
    block: bigint,
    logIndex: number,
  ) {
    stmts.deleteIndexRowsForKey.run(table, key)
    for (const index of getTableIndexes(schema, table)) {
      stmts.insertIndex.run(
        table,
        index.name,
        encodeIndexKey(index, value),
        key,
        Number(block),
        logIndex,
      )
    }
  }

  function writeRow(
    table: string,
    key: string,
    value: Record<string, unknown>,
    block: bigint,
    logIndex: number,
  ) {
    stmts.set.run(table, key, JSON.stringify(value, replacer), Number(block), logIndex)
    replaceIndexEntries(table, key, value, block, logIndex)
  }

  function deleteRow(table: string, key: string) {
    stmts.deleteIndexRowsForKey.run(table, key)
    stmts.del.run(table, key)
  }

  const store: Store = {
    kind: 'sqlite',
    async configureSchema(nextSchema) {
      schema = normalizeSchema(nextSchema)
      const rows = stmts.getAllDataEntries.all() as {
        table_name: string
        key: string
        value_json: string
        block: number
        log_index: number
      }[]
      stmts.clearIndexes.run()
      for (const row of rows) {
        replaceIndexEntries(
          row.table_name,
          row.key,
          JSON.parse(row.value_json, reviver),
          BigInt(row.block),
          row.log_index,
        )
      }
    },

    async get(table, key) {
      const row = stmts.get.get(table, key) as
        | { value_json: string }
        | undefined
      return row ? JSON.parse(row.value_json, reviver) : undefined
    },

    async getEntry(table, key) {
      const row = stmts.getEntry.get(table, key) as
        | { value_json: string; block: number; log_index: number }
        | undefined
      if (!row) return undefined
      return {
        value: JSON.parse(row.value_json, reviver),
        block: BigInt(row.block),
        logIndex: row.log_index,
      }
    },

    async getAll(table, filter?) {
      let rows: Record<string, unknown>[]
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
        rows = (stmts.getAllIndexed.all(
          table,
          index.name,
          encodeIndexKey(index, filter.where!),
        ) as { value_json: string }[]).map((r) => JSON.parse(r.value_json, reviver))
      } else {
        rows = (stmts.getAll.all(table) as { value_json: string }[]).map((r) =>
          JSON.parse(r.value_json, reviver),
        )
      }
      if (filter?.where && !filter.index) {
        rows = rows.filter((row: Record<string, unknown>) =>
          Object.entries(filter.where!).every(([k, v]) => row[k] === v),
        )
      }
      if (filter?.offset) rows = rows.slice(filter.offset)
      if (filter?.limit) rows = rows.slice(0, filter.limit)
      return rows
    },

    async set(table, key, value, block = 0n, logIndex = 0) {
      writeRow(table, key, value, block, logIndex)
    },

    async update(table, key, partial, block = 0n, logIndex = 0) {
      const row = stmts.get.get(table, key) as
        | { value_json: string }
        | undefined
      if (row) {
        const existing = JSON.parse(row.value_json, reviver)
        writeRow(
          table,
          key,
          { ...existing, ...partial },
          block,
          logIndex,
        )
      }
    },

    async delete(table, key) {
      deleteRow(table, key)
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
        mutation.previousBlock !== undefined ? Number(mutation.previousBlock) : null,
        mutation.previousLogIndex ?? null,
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
      stmts.clearIndexes.run()
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

    async getSchemaFingerprint() {
      const row = stmts.getMeta.get('schema_fingerprint') as
        | { value: string }
        | undefined
      return row?.value
    },

    async setSchemaFingerprint(fp) {
      stmts.setMeta.run('schema_fingerprint', fp)
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
