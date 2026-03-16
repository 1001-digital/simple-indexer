import { createIndexer, type StoreApi } from '../src/index.js'
import {
  CONTRACT_ADDRESS,
  ZERO_ADDRESS,
  erc1155Abi,
  envNumber,
  createStore,
  createClient,
  logConfig,
  logStatus,
  logChunk,
  logError,
} from './_shared.js'

function balanceKey(owner: `0x${string}`, tokenId: bigint) {
  return `${owner.toLowerCase()}:${tokenId}`
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
  const startBlock = 21_930_000n
  const endBlock = 21_938_955n
  const chunkSize = envNumber('CHUNK_SIZE', 16_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 2)

  logConfig('balance', startBlock, chunkSize, finalityDepth, endBlock)

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
        endBlock,
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
  indexer.onChunk(logChunk)

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
  logError(error)
  process.exitCode = 1
})
