import { describe, it, expect, vi } from 'vitest'
import {
  fetchAdaptiveRanges,
  forEachAdaptiveRange,
} from '../src/utils/adaptive-ranges'

describe('fetchAdaptiveRanges', () => {
  it('returns empty array when from > to', async () => {
    const fetch = vi.fn()
    const result = await fetchAdaptiveRanges({
      from: 10n,
      to: 5n,
      maxChunkSize: 10,
      fetch,
    })
    expect(result).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches a single chunk when range fits in maxChunkSize', async () => {
    const fetch = vi.fn(async () => 'data')
    const result = await fetchAdaptiveRanges({
      from: 0n,
      to: 4n,
      maxChunkSize: 10,
      fetch,
    })
    expect(result).toEqual([{ from: 0n, to: 4n, value: 'data' }])
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(0n, 4n)
  })

  it('splits into multiple chunks when range exceeds maxChunkSize', async () => {
    const fetch = vi.fn(async () => 'ok')
    const result = await fetchAdaptiveRanges({
      from: 0n,
      to: 9n,
      maxChunkSize: 5,
      initialChunkSize: 5,
      fetch,
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ from: 0n, to: 4n, value: 'ok' })
    expect(result[1]).toEqual({ from: 5n, to: 9n, value: 'ok' })
  })

  it('doubles chunk size on success until maxChunkSize', async () => {
    const calls: [bigint, bigint][] = []
    const fetch = vi.fn(async (from: bigint, to: bigint) => {
      calls.push([from, to])
      return null
    })

    await fetchAdaptiveRanges({
      from: 0n,
      to: 99n,
      maxChunkSize: 100,
      initialChunkSize: 2,
      fetch,
    })

    // First chunk: size 2 (0-1), then doubles to 4 (2-5), then 8 (6-13), etc.
    expect(calls[0]).toEqual([0n, 1n])
    expect(calls[1]).toEqual([2n, 5n])
    expect(calls[2]).toEqual([6n, 13n])
  })

  it('shrinks chunk size on failure', async () => {
    const calls: [bigint, bigint][] = []
    const fetch = vi.fn(async (from: bigint, to: bigint) => {
      calls.push([from, to])
      if (to - from + 1n > 4n) throw new Error('too large')
      return 'ok'
    })

    const result = await fetchAdaptiveRanges({
      from: 0n,
      to: 11n,
      maxChunkSize: 10,
      initialChunkSize: 10,
      fetch,
    })

    // Should eventually succeed despite initial failures
    const values = result.map((r) => r.value)
    expect(values.every((v) => v === 'ok')).toBe(true)
    // All blocks covered
    expect(result[0].from).toBe(0n)
    expect(result[result.length - 1].to).toBe(11n)
  })

  it('converges via binary search between success and failure sizes', async () => {
    const sizes: number[] = []
    // RPC rejects anything > 6 blocks
    const fetch = vi.fn(async (from: bigint, to: bigint) => {
      const size = Number(to - from + 1n)
      sizes.push(size)
      if (size > 6) throw new Error('too large')
      return size
    })

    await fetchAdaptiveRanges({
      from: 0n,
      to: 49n,
      maxChunkSize: 50,
      initialChunkSize: 10,
      fetch,
    })

    // 10 fails → halve to 5 → succeeds → binary search floor((5+10)/2)=7 → fails
    // → revert to lastSuccessfulSize 5 → succeeds → binary search floor((5+7)/2)=6
    expect(sizes[0]).toBe(10) // fail
    expect(sizes[1]).toBe(5) // succeed (halved)
    expect(sizes[2]).toBe(7) // binary search: floor((5+10)/2) → fail
    expect(sizes[3]).toBe(5) // revert to lastSuccessfulSize
    expect(sizes[4]).toBe(6) // binary search: floor((5+7)/2) → succeed
  })

  it('throws when chunk size reaches minChunkSize and still fails', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('always fails')
    })

    await expect(
      fetchAdaptiveRanges({
        from: 0n,
        to: 5n,
        maxChunkSize: 4,
        initialChunkSize: 4,
        minChunkSize: 1,
        fetch,
      }),
    ).rejects.toThrow('always fails')
  })

  it('respects custom minChunkSize', async () => {
    const sizes: number[] = []
    const fetch = vi.fn(async (from: bigint, to: bigint) => {
      const size = Number(to - from + 1n)
      sizes.push(size)
      throw new Error('fail')
    })

    await expect(
      fetchAdaptiveRanges({
        from: 0n,
        to: 99n,
        maxChunkSize: 100,
        initialChunkSize: 100,
        minChunkSize: 10,
        fetch,
      }),
    ).rejects.toThrow('fail')

    // Should stop shrinking at minChunkSize (10), not go below
    expect(sizes[sizes.length - 1]).toBeGreaterThanOrEqual(10)
  })

  it('reverts to lastSuccessfulSize on failure when available', async () => {
    let callCount = 0
    const sizes: number[] = []
    const fetch = vi.fn(async (from: bigint, to: bigint) => {
      callCount++
      const size = Number(to - from + 1n)
      sizes.push(size)
      // First call succeeds (size 4), second doubles to 8 and fails,
      // should revert to 4 (last successful)
      if (callCount === 2) throw new Error('too large')
      return 'ok'
    })

    await fetchAdaptiveRanges({
      from: 0n,
      to: 19n,
      maxChunkSize: 20,
      initialChunkSize: 4,
      fetch,
    })

    expect(sizes[0]).toBe(4) // success
    expect(sizes[1]).toBe(8) // doubled, fails
    expect(sizes[2]).toBe(4) // reverts to lastSuccessfulSize
  })

  it('handles single-block range', async () => {
    const fetch = vi.fn(async () => 42)
    const result = await fetchAdaptiveRanges({
      from: 5n,
      to: 5n,
      maxChunkSize: 10,
      fetch,
    })
    expect(result).toEqual([{ from: 5n, to: 5n, value: 42 }])
  })

  it('does not grow beyond maxChunkSize', async () => {
    const sizes: number[] = []
    const fetch = vi.fn(async (from: bigint, to: bigint) => {
      sizes.push(Number(to - from + 1n))
      return null
    })

    await fetchAdaptiveRanges({
      from: 0n,
      to: 999n,
      maxChunkSize: 20,
      initialChunkSize: 5,
      fetch,
    })

    expect(sizes.every((s) => s <= 20)).toBe(true)
  })
})

describe('forEachAdaptiveRange', () => {
  it('calls onChunk for each successful fetch', async () => {
    const chunks: { from: bigint; to: bigint; value: string }[] = []
    await forEachAdaptiveRange({
      from: 0n,
      to: 9n,
      maxChunkSize: 5,
      initialChunkSize: 5,
      fetch: async () => 'data',
      onChunk: async (chunk) => {
        chunks.push(chunk)
      },
    })

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ from: 0n, to: 4n, value: 'data' })
    expect(chunks[1]).toEqual({ from: 5n, to: 9n, value: 'data' })
  })
})
