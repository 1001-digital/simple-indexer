import { createIndexer, type IndexerConfig } from '../src/index.js'
import { createPublicClient, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'

const CRYPTOPUNKS = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const
const PUNK_ID = 1001n

const punkAbi = parseAbi([
  'event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex)',
])

async function main() {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_URL),
  }) as IndexerConfig['client']

  const { createSqliteStore } = await import('../src/sqlite.js')
  const store = createSqliteStore('./cryptopunk-1001.db')

  const indexer = createIndexer({
    client,
    store,
    version: 1,
    chunkSize: 50_000,
    finalityDepth: 2,
    contracts: {
      CryptoPunks: {
        abi: punkAbi,
        address: CRYPTOPUNKS,
        startBlock: 3_914_495n,
        events: {
          async PunkTransfer({ event, store }) {
            const punkIndex = event.args.punkIndex as bigint
            if (punkIndex !== PUNK_ID) return

            const from = event.args.from as `0x${string}`
            const to = event.args.to as `0x${string}`
            const key = `${event.block}:${event.logIndex}`

            await store.set('punk_1001_transfers', key, {
              from,
              to,
              block: event.block,
              transactionHash: event.transactionHash,
              logIndex: event.logIndex,
            })
          },
        },
      },
    },
  })

  indexer.onStatus((status) => {
    console.log(
      `[punk-1001] status=${status.phase} current=${status.currentBlock} latest=${status.latestBlock} progress=${(status.progress * 100).toFixed(3)}%`,
    )
  })

  indexer.onChunk((chunk) => {
    console.log(
      `[punk-1001] ${chunk.phase} chunk from=${chunk.from} to=${chunk.to} events=${chunk.eventCount}`,
    )
  })

  await indexer.start()

  console.log('[punk-1001] indexer is live')

  const transfers = await indexer.store.getAll('punk_1001_transfers')
  console.log(`[punk-1001] ${transfers.length} transfers`)
  console.dir(transfers, { depth: null })
}

main().catch((error) => {
  console.error('[punk-1001] failed', error)
  process.exitCode = 1
})
