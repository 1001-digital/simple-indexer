import {
  createIdbStore,
  createIndexer,
  createMemoryStore,
  type IndexerConfig,
  type IndexerStatus,
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

function mintKey(
  block: bigint,
  transactionHash: `0x${string}`,
  logIndex: number,
  tokenId: bigint,
) {
  return `${block}:${transactionHash}:${logIndex}:${tokenId}`
}

function logConfig(
  startBlock: bigint,
  chunkSize: number,
  finalityDepth: number,
) {
  console.log('[example] starting Opepen Artifacts mint indexer')
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

function logBackfillChunk(chunk: {
  from: bigint
  to: bigint
  size: number
  eventCount: number
}) {
  console.log(
    `[example] backfill chunk from=${chunk.from} to=${chunk.to} size=${chunk.size} events=${chunk.eventCount}`,
  )
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

async function main() {
  const startBlock = envBigInt('START_BLOCK', 0n)
  const chunkSize = envNumber('CHUNK_SIZE', 16_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 2)

  logConfig(startBlock, chunkSize, finalityDepth)

  const indexer = createIndexer({
    client: createClient(),
    store: await createStore(),
    version: 1,
    chunkSize,
    finalityDepth,
    onBackfillChunk: logBackfillChunk,
    contracts: {
      OpepenArtifacts: {
        abi: erc1155Abi,
        address: CONTRACT_ADDRESS,
        startBlock,
        events: {
          async TransferSingle({ event, store }) {
            if (event.args.from !== ZERO_ADDRESS) return

            const tokenId = event.args.id as bigint
            const amount = event.args.value as bigint
            const to = event.args.to as `0x${string}`
            const operator = event.args.operator as `0x${string}`
            const key = mintKey(
              event.block,
              event.transactionHash,
              event.logIndex,
              tokenId,
            )

            await store.set('artifact_mints', key, {
              tokenId,
              amount,
              to,
              operator,
              block: event.block,
              logIndex: event.logIndex,
              transactionHash: event.transactionHash,
              contractAddress: event.address,
              kind: 'single',
            })

            const current =
              (await store.get('artifact_mint_stats', `${tokenId}`)) ?? {}

            await store.set('artifact_mint_stats', `${tokenId}`, {
              tokenId,
              totalMinted:
                ((current.totalMinted as bigint | undefined) ?? 0n) + amount,
              mintEvents: ((current.mintEvents as number | undefined) ?? 0) + 1,
              latestMintBlock: event.block,
              latestMintTo: to,
            })
          },
          async TransferBatch({ event, store }) {
            if (event.args.from !== ZERO_ADDRESS) return

            const ids = event.args.ids as bigint[]
            const values = event.args.values as bigint[]
            const to = event.args.to as `0x${string}`
            const operator = event.args.operator as `0x${string}`

            for (let i = 0; i < ids.length; i++) {
              const tokenId = ids[i]
              const amount = values[i]
              const key = mintKey(
                event.block,
                event.transactionHash,
                event.logIndex,
                tokenId,
              )

              await store.set('artifact_mints', key, {
                tokenId,
                amount,
                to,
                operator,
                block: event.block,
                logIndex: event.logIndex,
                transactionHash: event.transactionHash,
                contractAddress: event.address,
                kind: 'batch',
              })

              const current =
                (await store.get('artifact_mint_stats', `${tokenId}`)) ?? {}

              await store.set('artifact_mint_stats', `${tokenId}`, {
                tokenId,
                totalMinted:
                  ((current.totalMinted as bigint | undefined) ?? 0n) + amount,
                mintEvents:
                  ((current.mintEvents as number | undefined) ?? 0) + 1,
                latestMintBlock: event.block,
                latestMintTo: to,
              })
            }
          },
        },
      },
    },
  })

  indexer.onStatus(logStatus)

  await indexer.start()

  console.log('[example] indexer is live')

  const recentMints = await indexer.store.getAll('artifact_mints', {
    limit: 20,
  })
  const stats = await indexer.store.getAll('artifact_mint_stats', {
    limit: 20,
  })

  console.log(`[example] recent mint rows: ${recentMints.length}`)
  console.dir(recentMints, { depth: null })
  console.log(`[example] mint stats rows: ${stats.length}`)
  console.dir(stats, { depth: null })
}

main().catch((error) => {
  logError(error, envBigInt('START_BLOCK', 0n))
  process.exitCode = 1
})
