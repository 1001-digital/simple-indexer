import {
  createIdbStore,
  createMemoryStore,
  type IndexerConfig,
} from '../src/index.js'
import type { Store } from '../src/types.js'
import { createPublicClient, http } from 'viem'
import { base, mainnet } from 'viem/chains'

export function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  return value ? Number(value) : fallback
}

export async function createStore(
  defaultKind: 'memory' | 'sqlite' | 'idb' = 'memory',
  defaults?: {
    sqlitePath?: string
    idbName?: string
  },
): Promise<Store> {
  const kind = process.env.STORE ?? defaultKind

  if (kind === 'sqlite') {
    const { createSqliteStore } = await import('../src/sqlite.js')
    return createSqliteStore(
      process.env.SQLITE_PATH ?? defaults?.sqlitePath ?? './indexer.db',
    )
  }

  if (kind === 'idb') {
    return createIdbStore(
      process.env.IDB_NAME ?? defaults?.idbName ?? 'indexer',
    )
  }

  return createMemoryStore()
}

export function createClient(
  defaultChain?: 'mainnet' | 'base',
): IndexerConfig['client'] {
  const chain =
    (process.env.CHAIN === 'base' ? 'base' : undefined) ??
    defaultChain ??
    'mainnet'

  return createPublicClient({
    chain: chain === 'base' ? base : mainnet,
    transport: http(process.env.RPC_URL),
  }) as IndexerConfig['client']
}
