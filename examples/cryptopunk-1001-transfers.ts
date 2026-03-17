/**
 * CryptoPunks indexer for Punk #1001 — transfers and buys.
 *
 * The CryptoPunks contract (0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB) has two
 * bugs in its PunkBought event that require workarounds:
 *
 * 1. toAddress is always 0x0
 *    The buyPunk() function transfers ownership before emitting PunkBought, so
 *    the event reads the new owner (msg.sender) into both fromAddress and
 *    toAddress — but then overwrites toAddress with the zero address. To get
 *    the real buyer we decode the ERC-20-style Transfer(from, to, value) log
 *    from the same transaction receipt (see getBuyerFromReceipt).
 *    This requires `includeTransactionReceipts: true` in the contract config.
 *
 * 2. value is 0 for acceptBidForPunk() calls
 *    When a punk owner accepts a standing bid via acceptBidForPunk(), the
 *    PunkBought event is emitted with value = 0 instead of the actual sale
 *    price. The real price is the bid amount from the most recent
 *    PunkBidEntered event for that punk. We track PunkBidEntered and fall back
 *    to the stored bid value whenever PunkBought.value is 0.
 */
import { createIndexer } from '../src/index.js'
import { parseAbi, decodeEventLog } from 'viem'
import type { CachedReceipt } from '../src/index.js'
import { envNumber, createStore, createClient } from './_shared.js'

const NAME = 'punk-1001'
const CRYPTOPUNKS = '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB' as const
const PUNK_ID = 1001n

const punkAbi = parseAbi([
  'event PunkTransfer(address indexed from, address indexed to, uint256 punkIndex)',
  'event PunkBought(uint256 indexed punkIndex, uint256 value, address indexed fromAddress, address indexed toAddress)',
  'event PunkBidEntered(uint256 indexed punkIndex, uint256 value, address indexed fromAddress)',
])

// Separate ABI for decoding Transfer logs from tx receipts (not subscribed to via getLogs)
const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

function getBuyerFromReceipt(receipt: CachedReceipt): `0x${string}` {
  const log = receipt.logs
    .filter((l) => l.address.toLowerCase() === CRYPTOPUNKS.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: transferAbi, ...l })
      } catch {
        return null
      }
    })
    .find((e) => e?.eventName === 'Transfer')

  return (log?.args as any)?.to as `0x${string}`
}

async function main() {
  const startBlock = 3_914_495n
  const maxChunkSize = envNumber('MAX_CHUNK_SIZE', 50_000)
  const finalityDepth = envNumber('FINALITY_DEPTH', 2)

  const storeKind =
    (process.env.STORE as 'memory' | 'sqlite' | 'idb') ?? 'sqlite'

  const indexer = createIndexer({
    name: NAME,
    client: createClient(),
    store: await createStore(storeKind, {
      sqlitePath: './cryptopunk-1001.db',
    }),
    version: 5,
    maxChunkSize,
    finalityDepth,
    contracts: {
      CryptoPunks: {
        abi: punkAbi,
        address: CRYPTOPUNKS,
        startBlock,
        includeTransactionReceipts: true,
        events: {
          PunkBidEntered: {
            args: { punkIndex: PUNK_ID },
            async handler({ event, store }) {
              const key = `${event.block}:${event.logIndex}`
              await store.set('punk_1001_bids', key, {
                value: event.args.value,
                from: event.args.fromAddress,
                block: event.block,
                transactionHash: event.transactionHash,
                logIndex: event.logIndex,
              })
            },
          },

          PunkBought: {
            args: { punkIndex: PUNK_ID },
            async handler({ event, store }) {
              // The contract bug emits toAddress as 0x0 — read the real buyer from Transfer
              const to = getBuyerFromReceipt(event.receipt!)
              const from = event.args.fromAddress as `0x${string}`
              const key = `${event.block}:${event.logIndex}`

              // acceptBidForPunk emits value as 0 — resolve from the last bid
              let value = event.args.value as bigint
              if (value === 0n) {
                const bids = await store.getAll('punk_1001_bids')
                const latest = bids[bids.length - 1]
                value = (latest?.value as bigint) ?? 0n
              }

              await store.set('punk_1001_buys', key, {
                from,
                to,
                value,
                block: event.block,
                transactionHash: event.transactionHash,
                logIndex: event.logIndex,
              })
            },
          },

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

  await indexer.start()

  console.log(`[${NAME}] indexer is live`)

  const transfers = await indexer.store.getAll('punk_1001_transfers')
  console.log(`[${NAME}] ${transfers.length} transfers`)
  console.dir(transfers, { depth: null })

  const buys = await indexer.store.getAll('punk_1001_buys')
  console.log(`[${NAME}] ${buys.length} buys`)
  console.dir(buys, { depth: null })
}

main().catch(console.error)
