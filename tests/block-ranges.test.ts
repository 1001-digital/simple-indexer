import { describe, it, expect } from 'vitest'
import { chunkRange } from '../src/utils/block-ranges'

describe('chunkRange', () => {
  it('splits a range into equal chunks', () => {
    const chunks = chunkRange(0n, 9n, 5)
    expect(chunks).toEqual([
      [0n, 4n],
      [5n, 9n],
    ])
  })

  it('handles a range smaller than chunk size', () => {
    const chunks = chunkRange(10n, 12n, 100)
    expect(chunks).toEqual([[10n, 12n]])
  })

  it('handles exact multiple', () => {
    const chunks = chunkRange(0n, 5n, 3)
    expect(chunks).toEqual([
      [0n, 2n],
      [3n, 5n],
    ])
  })

  it('handles single block', () => {
    const chunks = chunkRange(5n, 5n, 10)
    expect(chunks).toEqual([[5n, 5n]])
  })

  it('handles empty range (from > to)', () => {
    const chunks = chunkRange(10n, 5n, 3)
    expect(chunks).toEqual([])
  })

  it('handles large ranges', () => {
    const chunks = chunkRange(0n, 9999n, 2000)
    expect(chunks).toHaveLength(5)
    expect(chunks[0]).toEqual([0n, 1999n])
    expect(chunks[4]).toEqual([8000n, 9999n])
  })
})
