import {
  createIdbStore,
  createMemoryStore,
  type IndexerConfig,
  type IndexerStatus,
} from '../src/index.js'
import type { Store } from '../src/types.js'
import { createPublicClient, http, parseAbi } from 'viem'
import { base, mainnet } from 'viem/chains'

export const CONTRACT_ADDRESS =
  '0x03cd89170b64c9f0a392246a2e4a0c22fcd23a5b' as const satisfies `0x${string}`
export const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000' as const satisfies `0x${string}`

export const erc1155Abi = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
])

export function envBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name]
  return value ? BigInt(value) : fallback
}

export function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  return value ? Number(value) : fallback
}

export async function createStore(): Promise<Store> {
  const kind = process.env.STORE ?? 'memory'

  if (kind === 'sqlite') {
    const { createSqliteStore } = await import('../src/sqlite.js')
    return createSqliteStore(process.env.SQLITE_PATH ?? './opepen-artifacts.db')
  }

  if (kind === 'idb') {
    return createIdbStore(process.env.IDB_NAME ?? 'opepen-artifacts')
  }

  return createMemoryStore()
}

export function createClient(): IndexerConfig['client'] {
  const chain = process.env.CHAIN === 'base' ? base : mainnet
  return createPublicClient({
    chain,
    transport: http(process.env.RPC_URL),
  }) as IndexerConfig['client']
}

function getStoreKind() {
  return process.env.STORE ?? 'memory'
}

function getChainName() {
  return process.env.CHAIN === 'base' ? 'base' : 'mainnet'
}

export function logConfig(
  name: string,
  startBlock: bigint,
  chunkSize: number,
  finalityDepth: number,
  endBlock?: bigint,
) {
  console.log(`[example] starting Opepen Artifacts ${name} indexer`)
  console.log(`[example] contract: ${CONTRACT_ADDRESS}`)
  console.log(`[example] chain: ${getChainName()}`)
  console.log(`[example] store: ${getStoreKind()}`)
  console.log(`[example] start block: ${startBlock}`)
  if (endBlock !== undefined) {
    console.log(`[example] end block: ${endBlock}`)
  }
  console.log(`[example] chunk size: ${chunkSize}`)
  console.log(`[example] finality depth: ${finalityDepth}`)

  if (!process.env.RPC_URL) {
    console.warn(
      '[example] RPC_URL is not set; viem will use its default transport config',
    )
  }

  if (startBlock === 0n) {
    console.warn(
      '[example] START_BLOCK is 0. Some RPC providers reject wide eth_getLogs backfills. Set START_BLOCK near the contract deployment block.',
    )
  }
}

export function logStatus(status: IndexerStatus) {
  console.log(
    `[example] status=${status.phase} current=${status.currentBlock} latest=${status.latestBlock} progress=${(status.progress * 100).toFixed(3)}% (${status.currentBlock - status.startBlock}/${status.latestBlock - status.startBlock} blocks)`,
  )

  if (status.error) {
    console.error('[example] indexer status error:', status.error)
  }
}

export function logBackfillChunk(chunk: {
  from: bigint
  to: bigint
  size: number
  eventCount: number
}) {
  console.log(
    `[example] backfill chunk from=${chunk.from} to=${chunk.to} size=${chunk.size} events=${chunk.eventCount}`,
  )
}

export function logError(error: unknown, startBlock: bigint) {
  console.error('[example] execution failed')
  console.error(error)

  if (startBlock === 0n) {
    console.error(
      '[example] hint: set START_BLOCK in .env to reduce the first eth_getLogs range.',
    )
  }
}
