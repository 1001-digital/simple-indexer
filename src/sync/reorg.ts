import type { Store } from '../types.js'
import type { PublicClient } from 'viem'

/**
 * Extract block hashes from already-fetched events (zero RPC cost).
 */
export async function storeBlockHashesFromEvents(
  store: Store,
  events: { block: bigint; blockHash: string }[],
): Promise<void> {
  const seen = new Set<bigint>()
  for (const e of events) {
    if (seen.has(e.block)) continue
    seen.add(e.block)
    await store.setBlockHash(e.block, e.blockHash)
  }
}

/**
 * Check if the block at `cursor` has been reorged.
 * Returns the block number where the reorg starts, or undefined if no reorg.
 */
export async function detectReorg(
  client: PublicClient,
  store: Store,
  cursor: bigint,
): Promise<bigint | undefined> {
  const storedHash = await store.getBlockHash(cursor)
  if (!storedHash) return undefined

  try {
    const block = await client.getBlock({ blockNumber: cursor })
    if (block.hash === storedHash) return undefined

    // Reorg detected — scan backward to find the last verified-good block.
    // Skip blocks with no stored hash rather than assuming they're safe,
    // since hashes are only stored at checkpoint boundaries.
    let checkBlock = cursor - 1n
    while (checkBlock >= 0n) {
      const hash = await store.getBlockHash(checkBlock)
      if (!hash) {
        // No stored hash — can't verify this block, keep scanning
        checkBlock--
        continue
      }
      const chainBlock = await client.getBlock({ blockNumber: checkBlock })
      if (chainBlock.hash === hash) {
        return checkBlock + 1n
      }
      checkBlock--
    }

    return 0n
  } catch {
    return undefined
  }
}

/**
 * Rollback all state from `fromBlock` onwards and reset cursor.
 */
export async function handleReorg(
  store: Store,
  fromBlock: bigint,
): Promise<void> {
  await store.rollback(fromBlock)
  await store.removeEventsFrom(fromBlock)
  await store.removeBlockHashesFrom(fromBlock)
  await store.setCursor('_indexer', fromBlock - 1n)
  await store.setCursor('_events_watermark', fromBlock - 1n)
}
