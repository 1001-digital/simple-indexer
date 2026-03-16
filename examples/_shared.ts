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

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgCyan: '\x1b[46m',
}

function tag(name: string) {
  return `${c.cyan}${c.bold}[${name}]${c.reset}`
}

function label(text: string) {
  return `${c.dim}${text}${c.reset}`
}

function val(text: string | number | bigint) {
  return `${c.white}${c.bold}${text}${c.reset}`
}

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
  const t = tag(name)

  console.log(`${t} ${c.bold}${c.magenta}starting indexer${c.reset}`)
  console.log(`${t} ${label('contract')}  ${val(config.contract)}`)
  console.log(`${t} ${label('chain')}     ${val(chain)}`)
  console.log(`${t} ${label('store')}     ${val(config.store)}`)
  console.log(`${t} ${label('start')}     ${val(config.startBlock)}`)
  if (config.endBlock !== undefined) {
    console.log(`${t} ${label('end')}       ${val(config.endBlock)}`)
  }
  console.log(`${t} ${label('chunk')}     ${val(config.chunkSize)}`)
  console.log(`${t} ${label('finality')}  ${val(config.finalityDepth)}`)

  if (!process.env.RPC_URL) {
    console.warn(
      `${t} ${c.yellow}⚠ RPC_URL not set; viem will use default transport${c.reset}`,
    )
  }
}

export function logStatus(name: string) {
  return (status: IndexerStatus) => {
    const t = tag(name)
    const phaseColor = status.phase === 'live' ? c.green : c.yellow
    const pct = status.progress * 100
    const pctColor = pct >= 100 ? c.green : pct > 50 ? c.yellow : c.white
    const done = status.currentBlock - status.startBlock
    const total = status.latestBlock - status.startBlock

    console.log(
      `${t} ${phaseColor}${c.bold}${status.phase}${c.reset} ${label('block')} ${val(status.currentBlock)}${c.dim}/${c.reset}${val(status.latestBlock)} ${pctColor}${c.bold}${pct.toFixed(3)}%${c.reset} ${c.dim}(${done}/${total})${c.reset}`,
    )

    if (status.error) {
      console.error(`${t} ${c.red}${c.bold}error:${c.reset}`, status.error)
    }
  }
}

export function logChunk(name: string) {
  return (chunk: ChunkInfo) => {
    const t = tag(name)
    const phaseColor = chunk.phase === 'live' ? c.green : c.yellow
    const sourceLabel = chunk.cached
      ? `${c.green}cache${c.reset}`
      : `${c.blue}rpc${c.reset}`
    const evtColor = chunk.eventCount > 0 ? c.magenta : c.dim

    console.log(
      `${t} ${phaseColor}${chunk.phase}${c.reset} ${c.dim}chunk${c.reset} ${val(chunk.from)}${c.dim}→${c.reset}${val(chunk.to)} ${c.dim}size=${c.reset}${chunk.size} ${evtColor}events=${chunk.eventCount}${c.reset} ${sourceLabel}`,
    )
  }
}

export function logError(name: string) {
  return (error: unknown) => {
    const t = tag(name)
    console.error(`${t} ${c.bgRed}${c.white}${c.bold} FAILED ${c.reset}`)
    console.error(error)
  }
}
