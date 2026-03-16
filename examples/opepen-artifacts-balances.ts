import {
  createIdbStore,
  createIndexer,
  createMemoryStore,
  type IndexerConfig,
  type IndexerStatus,
  type StoreApi,
} from '../src/index.js'
import type { Store } from '../src/types.js'
import { createPublicClient, http, parseAbi } from 'viem'
import { base, mainnet } from 'viem/chains'

const CONTRACT_ADDRESS =
  '0x03cd89170b64c9f0a392246a2e4a0c22fcd23a5b' as const satisfies `0x${string}`
const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000' as const satisfies `0x${string}`

const erc1155Abi = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
])

function envBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name]
  return value ? BigInt(value) : fallback
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  return value ? Number(value) : fallback
}

async function createStore(): Promise<Store> {
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

function createClient(): IndexerConfig['client'] {
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

function balanceKey(owner: `0x${string}`, tokenId: bigint) {
  return `${owner.toLowerCase()}:${tokenId}`
}

function logConfig(
  startBlock: bigint,
  chunkSize: number,
  finalityDepth: number,
) {
  console.log('[example] starting Opepen Artifacts balance indexer')
  console.log(`[example] contract: ${CONTRACT_ADDRESS}`)
  console.log(`[example] chain: ${getChainName()}`)
  console.log(`[example] store: ${getStoreKind()}`)
  console.log(`[example] start block: ${startBlock}`)
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

function logStatus(status: IndexerStatus) {
  console.log(
    `[example] status=${status.phase} current=${status.currentBlock} latest=${status.latestBlock} progress=${status.progress.toFixed(1)}%`,
  )

  if (status.error) {
    console.error('[example] indexer status error:', status.error)
  }
}

function logError(error: unknown, startBlock: bigint) {
  console.error('[example] execution failed')
  console.error(error)

  if (startBlock === 0n) {
    console.error(
      '[example] hint: set START_BLOCK in .env to reduce the first eth_getLogs range.',
    )
  }
}

async function applyBalanceDelta(
  store: StoreApi,
  owner: `0x${string}`,
  tokenId: bigint,
  delta: bigint,
) {
  if (owner === ZERO_ADDRESS || delta === 0n) return

  const key = balanceKey(owner, tokenId)
  const current = await store.get('artifact_balances', key)
  const next = ((current?.balance as bigint | undefined) ?? 0n) + delta

  if (next < 0n) {
    throw new Error(`Negative balance for ${owner} token ${tokenId}`)
  }

  if (next === 0n) {
    await store.delete('artifact_balances', key)
    return
  }

  await store.set('artifact_balances', key, {
    owner: owner.toLowerCase(),
    tokenId,
    balance: next,
  })
}

async function applySupplyDelta(
  store: StoreApi,
  tokenId: bigint,
  delta: bigint,
) {
  if (delta === 0n) return

  const key = `${tokenId}`
  const current = await store.get('artifact_supply', key)
  const next = ((current?.supply as bigint | undefined) ?? 0n) + delta

  if (next < 0n) {
    throw new Error(`Negative supply for token ${tokenId}`)
  }

  await store.set('artifact_supply', key, {
    tokenId,
    supply: next,
  })
}

async function main() {
  const startBlock = envBigInt('START_BLOCK', 0n)
  const chunkSize = envNumber('CHUNK_SIZE', 2_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 2)

  logConfig(startBlock, chunkSize, finalityDepth)

  const indexer = createIndexer({
    client: createClient(),
    store: await createStore(),
    version: 1,
    chunkSize,
    finalityDepth,
    contracts: {
      OpepenArtifacts: {
        abi: erc1155Abi,
        address: CONTRACT_ADDRESS,
        startBlock,
        events: {
          async TransferSingle({ event, store }) {
            const tokenId = event.args.id as bigint
            const amount = event.args.value as bigint
            const from = event.args.from as `0x${string}`
            const to = event.args.to as `0x${string}`

            await applyBalanceDelta(store, from, tokenId, -amount)
            await applyBalanceDelta(store, to, tokenId, amount)

            if (from === ZERO_ADDRESS) {
              await applySupplyDelta(store, tokenId, amount)
            }

            if (to === ZERO_ADDRESS) {
              await applySupplyDelta(store, tokenId, -amount)
            }
          },
          async TransferBatch({ event, store }) {
            const ids = event.args.ids as bigint[]
            const values = event.args.values as bigint[]
            const from = event.args.from as `0x${string}`
            const to = event.args.to as `0x${string}`

            for (let i = 0; i < ids.length; i++) {
              const tokenId = ids[i]
              const amount = values[i]

              await applyBalanceDelta(store, from, tokenId, -amount)
              await applyBalanceDelta(store, to, tokenId, amount)

              if (from === ZERO_ADDRESS) {
                await applySupplyDelta(store, tokenId, amount)
              }

              if (to === ZERO_ADDRESS) {
                await applySupplyDelta(store, tokenId, -amount)
              }
            }
          },
        },
      },
    },
  })

  indexer.onStatus(logStatus)

  await indexer.start()

  console.log('[example] indexer is live')

  const balances = await indexer.store.getAll('artifact_balances', {
    limit: 20,
  })
  const supply = await indexer.store.getAll('artifact_supply', { limit: 20 })

  console.log(`[example] balance rows: ${balances.length}`)
  console.dir(balances, { depth: null })
  console.log(`[example] supply rows: ${supply.length}`)
  console.dir(supply, { depth: null })
}

main().catch((error) => {
  logError(error, envBigInt('START_BLOCK', 0n))
  process.exitCode = 1
})
