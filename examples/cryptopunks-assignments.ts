import { createIndexer } from '../src/index.js'
import { CONTRACT_ADDRESS, cryptoPunksAbi } from './_cryptopunks.js'
import { envNumber, createStore, createClient } from './_shared.js'

const NAME = 'cryptopunks-assignments'

async function main() {
  const startBlock = 3_842_489n
  const endBlock = 3_894_000n
  const maxChunkSize = envNumber('MAX_CHUNK_SIZE', 16_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 0)

  const storeKind = (process.env.STORE as 'memory' | 'sqlite' | 'idb') ?? 'memory'

  const indexer = createIndexer({
    name: NAME,
    client: createClient(),
    store: await createStore(storeKind, {
      sqlitePath: './cryptopunks.db',
    }),
    version: 1,
    maxChunkSize,
    finalityDepth,
    schema: {
      punks: {
        indexes: [
          { name: 'by_owner', fields: ['owner'] },
        ],
      },
    },
    contracts: {
      CryptoPunksV1: {
        abi: cryptoPunksAbi,
        address: CONTRACT_ADDRESS,
        startBlock,
        endBlock,
        events: {
          async Assign({ event, store }) {
            const to = event.args.to as `0x${string}`
            const punkIndex = event.args.punkIndex as bigint
            const key = `${punkIndex}`

            await store.set('punks', key, {
              punkIndex,
              owner: to.toLowerCase(),
              block: event.block,
              transactionHash: event.transactionHash,
            })
          },
        },
      },
    },
  })

  await indexer.start()

  console.log(`[${NAME}] indexer is live`)

  // Get owner of a specific punk
  const punk1000 = await indexer.store.get('punks', '1000')
  console.log(`[${NAME}] owner of punk #1000:`)
  console.dir(punk1000, { depth: null })

  // Get all punks for a specific owner
  if (punk1000) {
    const ownerPunks = await indexer.store.getAll('punks', {
      index: 'by_owner',
      where: { owner: punk1000.owner as string },
      limit: 20,
    })
    console.log(`[${NAME}] punks owned by ${punk1000.owner}: ${ownerPunks.length}`)
    console.dir(ownerPunks, { depth: null })
  }

  // Show total assignments
  const all = await indexer.store.getAll('punks')
  console.log(`[${NAME}] total punks assigned: ${all.length}`)
}

main().catch(console.error)
