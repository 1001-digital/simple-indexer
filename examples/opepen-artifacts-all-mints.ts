import { createIndexer } from '../src/index.js'
import {
  CONTRACT_ADDRESS,
  ZERO_ADDRESS,
  erc1155Abi,
  envBigInt,
  envNumber,
  createStore,
  createClient,
  logConfig,
  logStatus,
  logBackfillChunk,
  logError,
} from './_shared.js'

function mintKey(
  block: bigint,
  transactionHash: `0x${string}`,
  logIndex: number,
  tokenId: bigint,
) {
  return `${block}:${transactionHash}:${logIndex}:${tokenId}`
}

async function main() {
  const startBlock = envBigInt('START_BLOCK', 0n)
  const endBlock = envBigInt('END_BLOCK', 0n) || undefined
  const chunkSize = envNumber('CHUNK_SIZE', 16_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 2)

  logConfig('mint', startBlock, chunkSize, finalityDepth, endBlock)

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
