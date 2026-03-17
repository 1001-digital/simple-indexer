import type { Store, CachedEvent, CachedReceipt, IndexerSchema } from '../types.js'
import {
  encodeIndexKey,
  getIndexSchema,
  getTableIndexes,
  indexMatchesWhere,
  normalizeSchema,
  type NormalizedIndexerSchema,
} from './indexing.js'

const SEP = '\x00'

function dataKey(table: string, key: string): string {
  return `${table}${SEP}${key}`
}

function indexPrefix(table: string, indexName: string, indexKey: string): string {
  return `${table}${SEP}${indexName}${SEP}${indexKey}${SEP}`
}

function indexEntryKey(
  table: string,
  indexName: string,
  indexKeyValue: string,
  rowKey: string,
): string {
  return `${indexPrefix(table, indexName, indexKeyValue)}${rowKey}`
}

// BigInt-safe serialization for IDB structured clone
function serialize(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'bigint') {
      result[k] = `__bigint__${v.toString()}`
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        item && typeof item === 'object'
          ? serialize(item as Record<string, unknown>)
          : typeof item === 'bigint'
            ? `__bigint__${item.toString()}`
            : item,
      )
    } else if (v && typeof v === 'object') {
      result[k] = serialize(v as Record<string, unknown>)
    } else {
      result[k] = v
    }
  }
  return result
}

function deserialize(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.startsWith('__bigint__')) {
      result[k] = BigInt(v.slice(10))
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === 'string' && item.startsWith('__bigint__')
          ? BigInt(item.slice(10))
          : item && typeof item === 'object'
            ? deserialize(item as Record<string, unknown>)
            : item,
      )
    } else if (v && typeof v === 'object') {
      result[k] = deserialize(v as Record<string, unknown>)
    } else {
      result[k] = v
    }
  }
  return result
}

function serializeEvent(event: CachedEvent): Record<string, unknown> {
  return {
    block: event.block.toString(),
    logIndex: event.logIndex,
    contractName: event.contractName,
    eventName: event.eventName,
    args: serialize(event.args),
    address: event.address,
    transactionHash: event.transactionHash,
    blockHash: event.blockHash,
  }
}

function deserializeEvent(raw: Record<string, unknown>): CachedEvent {
  return {
    block: BigInt(raw.block as string),
    logIndex: raw.logIndex as number,
    contractName: raw.contractName as string,
    eventName: raw.eventName as string,
    args: deserialize(raw.args as Record<string, unknown>),
    address: raw.address as `0x${string}`,
    transactionHash: raw.transactionHash as `0x${string}`,
    blockHash: raw.blockHash as `0x${string}`,
  }
}

// Wrapper object stored in IDB for _data entries
interface IdbDataWrapper {
  value: Record<string, unknown>
  _block: number
  _logIndex: number
  _indexRefs?: string[]
}

interface IdbStoreOptions {
  schema?: IndexerSchema
}

interface IdbIndexWrapper {
  rowKey: string
  _block: number
  _logIndex: number
}

export function createIdbStore(dbName: string, options: IdbStoreOptions = {}): Store {
  let db: IDBDatabase | undefined
  let schema: NormalizedIndexerSchema = normalizeSchema(options.schema)

  function open(): Promise<IDBDatabase> {
    if (db) return Promise.resolve(db)
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 3)
      request.onupgradeneeded = () => {
        const d = request.result
        if (!d.objectStoreNames.contains('_data')) d.createObjectStore('_data')
        if (!d.objectStoreNames.contains('_index_data'))
          d.createObjectStore('_index_data')
        if (!d.objectStoreNames.contains('_events'))
          d.createObjectStore('_events', { autoIncrement: true })
        if (!d.objectStoreNames.contains('_cursors'))
          d.createObjectStore('_cursors')
        if (!d.objectStoreNames.contains('_mutations'))
          d.createObjectStore('_mutations', { autoIncrement: true })
        if (!d.objectStoreNames.contains('_meta')) d.createObjectStore('_meta')
        if (!d.objectStoreNames.contains('_blockhashes'))
          d.createObjectStore('_blockhashes')
        if (!d.objectStoreNames.contains('_receipts'))
          d.createObjectStore('_receipts')
      }
      request.onsuccess = () => {
        db = request.result
        resolve(db)
      }
      request.onerror = () => reject(request.error)
    })
  }

  // Unwrap a stored value — handles both old format (plain serialized value)
  // and new wrapper format ({ value, _block, _logIndex })
  function unwrapValue(stored: Record<string, unknown>): Record<string, unknown> {
    if (stored && 'value' in stored && '_block' in stored && '_logIndex' in stored) {
      return deserialize(stored.value as Record<string, unknown>)
    }
    // Legacy format: plain serialized value
    return deserialize(stored)
  }

  function unwrapEntry(stored: Record<string, unknown>): { value: Record<string, unknown>; block: bigint; logIndex: number } {
    if (stored && 'value' in stored && '_block' in stored && '_logIndex' in stored) {
      return {
        value: deserialize(stored.value as Record<string, unknown>),
        block: BigInt(stored._block as number),
        logIndex: stored._logIndex as number,
      }
    }
    // Legacy format
    return { value: deserialize(stored), block: 0n, logIndex: 0 }
  }

  function buildIndexRefs(
    table: string,
    key: string,
    value: Record<string, unknown>,
  ): string[] {
    return getTableIndexes(schema, table).map((index) =>
      indexEntryKey(table, index.name, encodeIndexKey(index, value), dataKey(table, key)),
    )
  }

  function putDataWithIndexes(
    tx: IDBTransaction,
    table: string,
    key: string,
    value: Record<string, unknown>,
    block: bigint,
    logIndex: number,
    previous?: IdbDataWrapper | Record<string, unknown>,
  ) {
    const dataStore = tx.objectStore('_data')
    const indexStore = tx.objectStore('_index_data')
    const refs =
      previous && '_indexRefs' in previous && Array.isArray(previous._indexRefs)
        ? (previous._indexRefs as string[])
        : []
    for (const ref of refs) indexStore.delete(ref)

    const wrapper: IdbDataWrapper = {
      value: serialize(value),
      _block: Number(block),
      _logIndex: logIndex,
    }
    const nextRefs = buildIndexRefs(table, key, value)
    if (nextRefs.length) {
      wrapper._indexRefs = nextRefs
      for (const ref of nextRefs) {
        const indexValue: IdbIndexWrapper = {
          rowKey: dataKey(table, key),
          _block: Number(block),
          _logIndex: logIndex,
        }
        indexStore.put(indexValue, ref)
      }
    }

    dataStore.put(wrapper, dataKey(table, key))
  }

  function deleteDataWithIndexes(
    tx: IDBTransaction,
    table: string,
    key: string,
    previous?: IdbDataWrapper | Record<string, unknown>,
  ) {
    const dataStore = tx.objectStore('_data')
    const indexStore = tx.objectStore('_index_data')
    const refs =
      previous && '_indexRefs' in previous && Array.isArray(previous._indexRefs)
        ? (previous._indexRefs as string[])
        : []
    for (const ref of refs) indexStore.delete(ref)
    dataStore.delete(dataKey(table, key))
  }

  const store: Store = {
    kind: 'idb',
    async configureSchema(nextSchema) {
      schema = normalizeSchema(nextSchema)
    },

    async rebuildIndexes() {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction(['_data', '_index_data'], 'readwrite')
        const dataStore = tx.objectStore('_data')
        const indexStore = tx.objectStore('_index_data')
        indexStore.clear()
        const req = dataStore.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          const raw = cursor.value as IdbDataWrapper | Record<string, unknown>
          const table = String(cursor.key).split(SEP, 1)[0]
          const value = unwrapValue(raw as Record<string, unknown>)
          const entry = unwrapEntry(raw as Record<string, unknown>)
          const rowKey = String(cursor.key)
          const refs = getTableIndexes(schema, table).map((index) => {
            const ref = indexEntryKey(table, index.name, encodeIndexKey(index, value), rowKey)
            indexStore.put(
              {
                rowKey,
                _block: Number(entry.block),
                _logIndex: entry.logIndex,
              } satisfies IdbIndexWrapper,
              ref,
            )
            return ref
          })
          const wrapper: IdbDataWrapper = {
            value: serialize(value),
            _block: Number(entry.block),
            _logIndex: entry.logIndex,
          }
          if (refs.length) wrapper._indexRefs = refs
          dataStore.put(wrapper, rowKey)
          cursor.continue()
        }
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async get(table, key) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_data', 'readonly')
        const req = tx.objectStore('_data').get(dataKey(table, key))
        req.onsuccess = () =>
          resolve(req.result ? unwrapValue(req.result) : undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async getEntry(table, key) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_data', 'readonly')
        const req = tx.objectStore('_data').get(dataKey(table, key))
        req.onsuccess = () =>
          resolve(req.result ? unwrapEntry(req.result) : undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async getAll(table, filter?) {
      const d = await open()
      return new Promise((resolve, reject) => {
        if (filter?.index) {
          const index = getIndexSchema(schema, table, filter.index)
          if (!index) {
            reject(new Error(`Index "${filter.index}" is not declared for table "${table}"`))
            return
          }
          if (!indexMatchesWhere(index, filter.where)) {
            reject(
              new Error(
                `Indexed query on "${table}" must provide exactly these fields: ${index.fields.join(', ')}`,
              ),
            )
            return
          }

          const tx = d.transaction(['_data', '_index_data'], 'readonly')
          const dataStore = tx.objectStore('_data')
          const indexStore = tx.objectStore('_index_data')
          const prefix = indexPrefix(table, index.name, encodeIndexKey(index, filter.where!))
          const req = indexStore.getAll(
            IDBKeyRange.bound(prefix, `${prefix}\uffff`),
          )
          req.onsuccess = async () => {
            try {
              const refs = req.result as IdbIndexWrapper[]
              const loaded = await Promise.all(
                refs.map(
                  (ref) =>
                    new Promise<{ value: Record<string, unknown>; block: bigint; logIndex: number } | null>((resolveEntry, rejectEntry) => {
                      const getReq = dataStore.get(ref.rowKey)
                      getReq.onsuccess = () => {
                        resolveEntry(
                          getReq.result
                            ? unwrapEntry(getReq.result as Record<string, unknown>)
                            : null,
                        )
                      }
                      getReq.onerror = () => rejectEntry(getReq.error)
                    }),
                ),
              )
              let rows = loaded
                .filter((entry): entry is { value: Record<string, unknown>; block: bigint; logIndex: number } => entry !== null)
                .sort((a, b) => {
                  if (a.block !== b.block) return a.block < b.block ? -1 : 1
                  return a.logIndex - b.logIndex
                })
                .map((entry) => entry.value)
              if (filter.offset) rows = rows.slice(filter.offset)
              if (filter.limit) rows = rows.slice(0, filter.limit)
              resolve(rows)
            } catch (error) {
              reject(error)
            }
          }
          req.onerror = () => reject(req.error)
          return
        }

        const tx = d.transaction('_data', 'readonly')
        const range = IDBKeyRange.bound(`${table}${SEP}`, `${table}${SEP}\uffff`)
        const req = tx.objectStore('_data').getAll(range)
        req.onsuccess = () => {
          const raw = req.result as Record<string, unknown>[]
          const entries = raw.map((r) => unwrapEntry(r))
          entries.sort((a, b) => {
            if (a.block !== b.block) return a.block < b.block ? -1 : 1
            return a.logIndex - b.logIndex
          })
          let rows = entries.map((e) => e.value)
          if (filter?.where) {
            rows = rows.filter((row) =>
              Object.entries(filter.where!).every(([k, v]) => row[k] === v),
            )
          }
          if (filter?.offset) rows = rows.slice(filter.offset)
          if (filter?.limit) rows = rows.slice(0, filter.limit)
          resolve(rows)
        }
        req.onerror = () => reject(req.error)
      })
    },

    async set(table, key, value, block = 0n, logIndex = 0) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction(['_data', '_index_data'], 'readwrite')
        const dataStore = tx.objectStore('_data')
        const getReq = dataStore.get(dataKey(table, key))
        getReq.onsuccess = () => {
          putDataWithIndexes(
            tx,
            table,
            key,
            value,
            block,
            logIndex,
            getReq.result as IdbDataWrapper | Record<string, unknown> | undefined,
          )
        }
        getReq.onerror = () => reject(getReq.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async update(table, key, partial, block = 0n, logIndex = 0) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction(['_data', '_index_data'], 'readwrite')
        const s = tx.objectStore('_data')
        const k = dataKey(table, key)
        const getReq = s.get(k)
        getReq.onsuccess = () => {
          if (getReq.result) {
            const existing = unwrapValue(getReq.result)
            putDataWithIndexes(
              tx,
              table,
              key,
              { ...existing, ...partial },
              block,
              logIndex,
              getReq.result as IdbDataWrapper | Record<string, unknown>,
            )
          }
        }
        getReq.onerror = () => reject(getReq.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async delete(table, key) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction(['_data', '_index_data'], 'readwrite')
        const dataStore = tx.objectStore('_data')
        const k = dataKey(table, key)
        const getReq = dataStore.get(k)
        getReq.onsuccess = () => {
          deleteDataWithIndexes(
            tx,
            table,
            key,
            getReq.result as IdbDataWrapper | Record<string, unknown> | undefined,
          )
        }
        getReq.onerror = () => reject(getReq.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async getCursor(name) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_cursors', 'readonly')
        const req = tx.objectStore('_cursors').get(name)
        req.onsuccess = () =>
          resolve(
            req.result !== undefined ? BigInt(req.result as string) : undefined,
          )
        req.onerror = () => reject(req.error)
      })
    },

    async setCursor(name, block) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_cursors', 'readwrite')
        tx.objectStore('_cursors').put(block.toString(), name)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async deleteCursor(name) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_cursors', 'readwrite')
        tx.objectStore('_cursors').delete(name)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async recordMutation(mutation) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_mutations', 'readwrite')
        tx.objectStore('_mutations').add({
          block: mutation.block.toString(),
          table: mutation.table,
          key: mutation.key,
          op: mutation.op,
          previous: mutation.previous
            ? serialize(mutation.previous)
            : undefined,
          previousBlock: mutation.previousBlock !== undefined
            ? mutation.previousBlock.toString()
            : undefined,
          previousLogIndex: mutation.previousLogIndex,
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async rollback(fromBlock) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction(['_mutations', '_data', '_index_data'], 'readwrite')
        const mutStore = tx.objectStore('_mutations')

        // Collect mutations in reverse, then apply rollbacks
        const toRollback: {
          key: IDBValidKey
          value: Record<string, unknown>
        }[] = []

        function applyRollbackAt(index: number) {
          if (index >= toRollback.length) return
          const { key: mutKey, value: mut } = toRollback[index]
          const rowTable = mut.table as string
          const rowKey = mut.key as string
          const currentReq = tx.objectStore('_data').get(dataKey(rowTable, rowKey))
          currentReq.onsuccess = () => {
            const current = currentReq.result as
              | IdbDataWrapper
              | Record<string, unknown>
              | undefined
            if (mut.op === 'set' || mut.op === 'update') {
              if (mut.previous) {
                putDataWithIndexes(
                  tx,
                  rowTable,
                  rowKey,
                  deserialize(mut.previous as Record<string, unknown>),
                  mut.previousBlock !== undefined ? BigInt(mut.previousBlock as string) : 0n,
                  (mut.previousLogIndex as number) ?? 0,
                  current,
                )
              } else {
                deleteDataWithIndexes(tx, rowTable, rowKey, current)
              }
            } else if (mut.op === 'delete' && mut.previous) {
              putDataWithIndexes(
                tx,
                rowTable,
                rowKey,
                deserialize(mut.previous as Record<string, unknown>),
                mut.previousBlock !== undefined ? BigInt(mut.previousBlock as string) : 0n,
                (mut.previousLogIndex as number) ?? 0,
                current,
              )
            }
            mutStore.delete(mutKey)
            applyRollbackAt(index + 1)
          }
          currentReq.onerror = () => reject(currentReq.error)
        }

        const cursorReq = mutStore.openCursor(null, 'prev')
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) {
            applyRollbackAt(0)
            return
          }

          const m = cursor.value
          if (BigInt(m.block as string) >= fromBlock) {
            toRollback.push({ key: cursor.key, value: m })
            cursor.continue()
          } else {
            applyRollbackAt(0)
          }
        }
        cursorReq.onerror = () => reject(cursorReq.error)

        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async pruneHistory(belowBlock) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_mutations', 'readwrite')
        const s = tx.objectStore('_mutations')
        const req = s.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          if (BigInt(cursor.value.block as string) < belowBlock) {
            cursor.delete()
            cursor.continue()
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async getEvents(from?, to?) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_events', 'readonly')
        const req = tx.objectStore('_events').getAll()
        req.onsuccess = () => {
          const all = (req.result as Record<string, unknown>[])
            .map(deserializeEvent)
            .filter((e) => {
              if (from !== undefined && e.block < from) return false
              if (to !== undefined && e.block > to) return false
              return true
            })
            .sort((a, b) => {
              if (a.block !== b.block) return a.block < b.block ? -1 : 1
              return a.logIndex - b.logIndex
            })
          resolve(all)
        }
        req.onerror = () => reject(req.error)
      })
    },

    async appendEvents(events) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_events', 'readwrite')
        const s = tx.objectStore('_events')
        for (const event of events) {
          s.add(serializeEvent(event))
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async removeEventsFrom(block) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_events', 'readwrite')
        const s = tx.objectStore('_events')
        const req = s.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          if (
            BigInt((cursor.value as Record<string, unknown>).block as string) >=
            block
          ) {
            cursor.delete()
          }
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async removeEventsRange(from, to) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_events', 'readwrite')
        const s = tx.objectStore('_events')
        const req = s.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          const block = BigInt(
            (cursor.value as Record<string, unknown>).block as string,
          )
          if (block >= from && block <= to) {
            cursor.delete()
          }
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async getReceipt(hash) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_receipts', 'readonly')
        const req = tx.objectStore('_receipts').get(hash)
        req.onsuccess = () => {
          if (!req.result) return resolve(undefined)
          const raw = req.result as Record<string, unknown>
          resolve({
            transactionHash: raw.transactionHash as `0x${string}`,
            blockNumber: BigInt(raw.blockNumber as string),
            logs: raw.logs as CachedReceipt['logs'],
          })
        }
        req.onerror = () => reject(req.error)
      })
    },

    async appendReceipts(receipts) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_receipts', 'readwrite')
        const s = tx.objectStore('_receipts')
        for (const r of receipts) {
          s.put(
            {
              transactionHash: r.transactionHash,
              blockNumber: r.blockNumber.toString(),
              logs: r.logs,
            },
            r.transactionHash,
          )
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async removeReceiptsFrom(block) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_receipts', 'readwrite')
        const s = tx.objectStore('_receipts')
        const req = s.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          const raw = cursor.value as Record<string, unknown>
          if (BigInt(raw.blockNumber as string) >= block) {
            cursor.delete()
          }
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async removeReceiptsRange(from, to) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_receipts', 'readwrite')
        const s = tx.objectStore('_receipts')
        const req = s.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          const raw = cursor.value as Record<string, unknown>
          const bn = BigInt(raw.blockNumber as string)
          if (bn >= from && bn <= to) {
            cursor.delete()
          }
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async clearDerivedState() {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction(['_data', '_index_data', '_mutations'], 'readwrite')
        tx.objectStore('_data').clear()
        tx.objectStore('_index_data').clear()
        tx.objectStore('_mutations').clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async getVersion() {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_meta', 'readonly')
        const req = tx.objectStore('_meta').get('version')
        req.onsuccess = () =>
          resolve(req.result !== undefined ? Number(req.result) : undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async setVersion(v) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_meta', 'readwrite')
        tx.objectStore('_meta').put(v, 'version')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async getEventFingerprint() {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_meta', 'readonly')
        const req = tx.objectStore('_meta').get('event_fingerprint')
        req.onsuccess = () =>
          resolve(req.result !== undefined ? (req.result as string) : undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async setEventFingerprint(fp) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_meta', 'readwrite')
        tx.objectStore('_meta').put(fp, 'event_fingerprint')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async getSchemaFingerprint() {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_meta', 'readonly')
        const req = tx.objectStore('_meta').get('schema_fingerprint')
        req.onsuccess = () =>
          resolve(req.result !== undefined ? (req.result as string) : undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async setSchemaFingerprint(fp) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_meta', 'readwrite')
        tx.objectStore('_meta').put(fp, 'schema_fingerprint')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async getBlockHash(block) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_blockhashes', 'readonly')
        const req = tx.objectStore('_blockhashes').get(block.toString())
        req.onsuccess = () => resolve(req.result as string | undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async setBlockHash(block, hash) {
      const d = await open()
      return new Promise((resolve, reject) => {
        const tx = d.transaction('_blockhashes', 'readwrite')
        tx.objectStore('_blockhashes').put(hash, block.toString())
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },

    async removeBlockHashesFrom(block) {
      const d = await open()
      return new Promise<void>((resolve, reject) => {
        const tx = d.transaction('_blockhashes', 'readwrite')
        const s = tx.objectStore('_blockhashes')
        const req = s.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          if (BigInt(cursor.key as string) >= block) {
            cursor.delete()
          }
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
  }

  return store
}
