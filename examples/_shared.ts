import {
  createIdbStore,
  createMemoryStore,
  type IndexerConfig,
  type IndexerStatus,
  type ChunkInfo,
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

export function logConfig(
  name: string,
  config: {
    contract: string
    store: string
    startBlock: bigint
    chunkSize: number
    finalityDepth: number
    endBlock?: bigint
  },
) {
  const chain = process.env.CHAIN === 'base' ? 'base' : 'mainnet'

  console.log(`[${name}] starting indexer`)
  console.log(`[${name}] contract: ${config.contract}`)
  console.log(`[${name}] chain: ${chain}`)
  console.log(`[${name}] store: ${config.store}`)
  console.log(`[${name}] start block: ${config.startBlock}`)
  if (config.endBlock !== undefined) {
    console.log(`[${name}] end block: ${config.endBlock}`)
  }
  console.log(`[${name}] chunk size: ${config.chunkSize}`)
  console.log(`[${name}] finality depth: ${config.finalityDepth}`)

  if (!process.env.RPC_URL) {
    console.warn(
      `[${name}] RPC_URL is not set; viem will use its default transport config`,
    )
  }
}

export function logStatus(name: string) {
  return (status: IndexerStatus) => {
    console.log(
      `[${name}] status=${status.phase} current=${status.currentBlock} latest=${status.latestBlock} progress=${(status.progress * 100).toFixed(3)}% (${status.currentBlock - status.startBlock}/${status.latestBlock - status.startBlock} blocks)`,
    )

    if (status.error) {
      console.error(`[${name}] indexer status error:`, status.error)
    }
  }
}

export function logChunk(name: string) {
  return (chunk: ChunkInfo) => {
    const source = chunk.cached ? 'cache' : 'rpc'
    console.log(
      `[${name}] ${chunk.phase} chunk from=${chunk.from} to=${chunk.to} size=${chunk.size} events=${chunk.eventCount} source=${source}`,
    )
  }
}

export function logError(name: string) {
  return (error: unknown) => {
    console.error(`[${name}] execution failed`)
    console.error(error)
  }
}
