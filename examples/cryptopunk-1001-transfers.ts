import { createIndexer } from '../src/index.js'
import { parseAbi } from 'viem'
import {
  envNumber,
  createStore,
  createClient,
  logConfig,
  logStatus,
  logChunk,
  logError,
} from './_shared.js'

const NAME = 'punk-1001'
const CRYPTOPUNKS =
  '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const
const PUNK_ID = 1001n

const punkAbi = parseAbi([
  'event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex)',
])

async function main() {
  const startBlock = 3_914_495n
  const chunkSize = envNumber('CHUNK_SIZE', 50_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 2)

  logConfig(NAME, {
    contract: CRYPTOPUNKS,
    startBlock,
    chunkSize,
    finalityDepth,
  })

  const indexer = createIndexer({
    client: createClient(),
    store: await createStore({ sqlitePath: './cryptopunk-1001.db' }),
    version: 1,
    chunkSize,
    finalityDepth,
    contracts: {
      CryptoPunks: {
        abi: punkAbi,
        address: CRYPTOPUNKS,
        startBlock,
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

  indexer.onStatus(logStatus(NAME))
  indexer.onChunk(logChunk(NAME))

  await indexer.start()

  console.log(`[${NAME}] indexer is live`)

  const transfers = await indexer.store.getAll('punk_1001_transfers')
  console.log(`[${NAME}] ${transfers.length} transfers`)
  console.dir(transfers, { depth: null })
}

main().catch(logError(NAME))
