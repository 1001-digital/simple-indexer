import { createIndexer } from '../src/index.js'
import { zeroAddress } from 'viem'
import { CONTRACT_ADDRESS, erc1155Abi } from './_opepen.js'
import {
  envNumber,
  createStore,
  createClient,
  logConfig,
  logStatus,
  logChunk,
  logError,
} from './_shared.js'

const NAME = 'opepen-mints'

function mintKey(
  block: bigint,
  transactionHash: `0x${string}`,
  logIndex: number,
  tokenId: bigint,
) {
  return `${block}:${transactionHash}:${logIndex}:${tokenId}`
}

async function main() {
  const startBlock = 21_930_000n
  const endBlock = 21_938_955n
  const chunkSize = envNumber('CHUNK_SIZE', 16_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 2)

  const storeKind = (process.env.STORE as 'memory' | 'sqlite' | 'idb') ?? 'memory'

  logConfig(NAME, {
    contract: CONTRACT_ADDRESS,
    store: storeKind,
    startBlock,
    chunkSize,
    finalityDepth,
    endBlock,
  })

  const indexer = createIndexer({
    client: createClient(),
    store: await createStore(storeKind, {
      sqlitePath: './opepen-artifacts.db',
    }),
    version: 1,
    chunkSize,
    finalityDepth,
    contracts: {
      OpepenArtifacts: {
        abi: erc1155Abi,
        address: CONTRACT_ADDRESS,
        startBlock,
        endBlock,
        events: {
          async TransferSingle({ event, store }) {
            if (event.args.from !== zeroAddress) return

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
            if (event.args.from !== zeroAddress) return

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

  indexer.onStatus(logStatus(NAME))
  indexer.onChunk(logChunk(NAME))

  await indexer.start()

  console.log(`[${NAME}] indexer is live`)

  const recentMints = await indexer.store.getAll('artifact_mints', {
    limit: 20,
  })
  const stats = await indexer.store.getAll('artifact_mint_stats', {
    limit: 20,
  })

  console.log(`[${NAME}] recent mint rows: ${recentMints.length}`)
  console.dir(recentMints, { depth: null })
  console.log(`[${NAME}] mint stats rows: ${stats.length}`)
  console.dir(stats, { depth: null })
}

main().catch(logError(NAME))
