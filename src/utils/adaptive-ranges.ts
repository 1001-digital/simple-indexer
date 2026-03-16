export interface AdaptiveRangeOptions<T> {
  from: bigint
  to: bigint
  maxChunkSize: number
  initialChunkSize?: number
  minChunkSize?: number
  fetch: (from: bigint, to: bigint) => Promise<T>
}

async function runAdaptiveRanges<T>(
  options: AdaptiveRangeOptions<T> & {
    onChunk?: (chunk: { from: bigint; to: bigint; value: T }) => Promise<void>
  },
): Promise<{ from: bigint; to: bigint; value: T }[]> {
  const {
    from,
    to,
    maxChunkSize,
    initialChunkSize = Math.min(options.maxChunkSize, 2000),
    minChunkSize = 1,
    fetch,
    onChunk,
  } = options

  if (from > to) return []

  const maxSize = Math.max(1, maxChunkSize)
  const minSize = Math.max(1, Math.min(minChunkSize, maxSize))
  let currentSize = Math.max(1, Math.min(initialChunkSize, maxSize))
  let lastSuccessfulSize: number | undefined
  let smallestFailedSize: number | undefined
  let cursor = from
  const results: { from: bigint; to: bigint; value: T }[] = []

  while (cursor <= to) {
    const end =
      cursor + BigInt(currentSize) - 1n > to
        ? to
        : cursor + BigInt(currentSize) - 1n

    try {
      const value = await fetch(cursor, end)
      const chunk = { from: cursor, to: end, value }
      results.push(chunk)
      if (onChunk) {
        await onChunk(chunk)
      }

      const actualSize = Number(end - cursor + 1n)
      lastSuccessfulSize = Math.max(lastSuccessfulSize ?? 0, actualSize)

      if (actualSize === currentSize) {
        if (
          smallestFailedSize !== undefined &&
          lastSuccessfulSize < smallestFailedSize - 1
        ) {
          currentSize = Math.min(
            maxSize,
            Math.floor((lastSuccessfulSize + smallestFailedSize) / 2),
          )
        } else if (smallestFailedSize === undefined && currentSize < maxSize) {
          currentSize = Math.min(maxSize, currentSize * 2)
        } else {
          currentSize = lastSuccessfulSize
        }
      }

      cursor = end + 1n
    } catch (error) {
      if (currentSize <= minSize) {
        throw error
      }

      smallestFailedSize =
        smallestFailedSize === undefined
          ? currentSize
          : Math.min(smallestFailedSize, currentSize)

      if (
        lastSuccessfulSize !== undefined &&
        lastSuccessfulSize >= minSize &&
        lastSuccessfulSize < currentSize
      ) {
        currentSize = lastSuccessfulSize
      } else {
        currentSize = Math.max(minSize, Math.floor(currentSize / 2))
      }
    }
  }

  return results
}

export async function fetchAdaptiveRanges<T>(
  options: AdaptiveRangeOptions<T>,
): Promise<{ from: bigint; to: bigint; value: T }[]> {
  return runAdaptiveRanges(options)
}

export async function forEachAdaptiveRange<T>(
  options: AdaptiveRangeOptions<T> & {
    onChunk: (chunk: { from: bigint; to: bigint; value: T }) => Promise<void>
  },
): Promise<void> {
  await runAdaptiveRanges(options)
}
