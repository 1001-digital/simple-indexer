import {
  createIdbStore,
  createIndexer,
  createMemoryStore,
  type IndexerConfig,
} from '@1001-digital/simple-indexer'
import type { Store } from '@1001-digital/simple-indexer'
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

async function createStore(): Promise<Store> {
  const kind = process.env.STORE ?? 'memory'

  if (kind === 'sqlite') {
    const { createSqliteStore } =
      await import('@1001-digital/simple-indexer/sqlite')
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

function mintKey(
  block: bigint,
  transactionHash: `0x${string}`,
  logIndex: number,
  tokenId: bigint,
) {
  return `${block}:${transactionHash}:${logIndex}:${tokenId}`
}

const indexer = createIndexer({
  client: createClient(),
  store: await createStore(),
  version: 1,
  contracts: {
    OpepenArtifacts: {
      abi: erc1155Abi,
      address: CONTRACT_ADDRESS,
      startBlock: envBigInt('START_BLOCK', 0n),
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
              mintEvents: ((current.mintEvents as number | undefined) ?? 0) + 1,
              latestMintBlock: event.block,
              latestMintTo: to,
            })
          }
        },
      },
    },
  },
})

await indexer.start()

console.log('Indexer is live', indexer.status)

const recentMints = await indexer.store.getAll('artifact_mints', { limit: 20 })
console.log('Recent mint rows', recentMints)
