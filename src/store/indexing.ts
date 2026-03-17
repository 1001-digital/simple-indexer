import type { IndexerSchema, TableIndexSchema } from '../types.js'

export interface NormalizedTableIndexSchema extends TableIndexSchema {
  fields: [string, ...string[]]
}

export interface NormalizedTableSchema {
  indexes: NormalizedTableIndexSchema[]
}

export type NormalizedIndexerSchema = Record<string, NormalizedTableSchema>

function encodeScalar(value: unknown): string {
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (typeof value === 'string') return `string:${value}`
  if (typeof value === 'number') return `number:${value}`
  if (typeof value === 'boolean') return `boolean:${value ? '1' : '0'}`
  if (value === null) return 'null:'
  if (value === undefined) return 'undefined:'
  throw new Error(`Unsupported indexed value type: ${typeof value}`)
}

export function normalizeSchema(schema?: IndexerSchema): NormalizedIndexerSchema {
  const normalized: NormalizedIndexerSchema = {}
  if (!schema) return normalized

  for (const [table, tableSchema] of Object.entries(schema)) {
    const rawIndexes = tableSchema.indexes ?? []
    const names = new Set<string>()
    const fieldSets = new Set<string>()
    const indexes: NormalizedTableIndexSchema[] = []

    for (const index of rawIndexes) {
      if (!index.name) {
        throw new Error(`Schema index on table "${table}" is missing a name`)
      }
      if (names.has(index.name)) {
        throw new Error(`Duplicate index name "${index.name}" on table "${table}"`)
      }
      if (!index.fields.length) {
        throw new Error(`Index "${index.name}" on table "${table}" must declare at least one field`)
      }

      const seenFields = new Set<string>()
      const fields = index.fields.map((field) => {
        if (!field) {
          throw new Error(`Index "${index.name}" on table "${table}" contains an empty field name`)
        }
        if (seenFields.has(field)) {
          throw new Error(`Index "${index.name}" on table "${table}" contains duplicate field "${field}"`)
        }
        seenFields.add(field)
        return field
      }) as [string, ...string[]]

      const fieldSetKey = fields.join('\x1f')
      if (fieldSets.has(fieldSetKey)) {
        throw new Error(`Duplicate index fields "${fields.join(', ')}" on table "${table}"`)
      }

      names.add(index.name)
      fieldSets.add(fieldSetKey)
      indexes.push({ name: index.name, fields })
    }

    normalized[table] = { indexes }
  }

  return normalized
}

export function getTableIndexes(
  schema: NormalizedIndexerSchema,
  table: string,
): NormalizedTableIndexSchema[] {
  return schema[table]?.indexes ?? []
}

export function getIndexSchema(
  schema: NormalizedIndexerSchema,
  table: string,
  indexName: string,
): NormalizedTableIndexSchema | undefined {
  return getTableIndexes(schema, table).find((index) => index.name === indexName)
}

export function encodeIndexKey(
  index: Pick<TableIndexSchema, 'fields'>,
  value: Record<string, unknown>,
): string {
  return JSON.stringify(index.fields.map((field) => encodeScalar(value[field])))
}

export function indexMatchesWhere(
  index: Pick<TableIndexSchema, 'fields'>,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return false
  if (Object.keys(where).length !== index.fields.length) return false
  return index.fields.every((field) => Object.prototype.hasOwnProperty.call(where, field))
}

export function computeSchemaFingerprint(schema: NormalizedIndexerSchema): string {
  return Object.entries(schema)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, tableSchema]) => {
      const indexes = [...tableSchema.indexes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((index) => `${index.name}:${index.fields.join('|')}`)
        .join(',')
      return `${table}=>${indexes}`
    })
    .join(';')
}
