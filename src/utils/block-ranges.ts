export function chunkRange(
  from: bigint,
  to: bigint,
  size: number,
): [bigint, bigint][] {
  const chunks: [bigint, bigint][] = []
  const sizeN = BigInt(size)
  let start = from

  while (start <= to) {
    const end = start + sizeN - 1n > to ? to : start + sizeN - 1n
    chunks.push([start, end])
    start = end + 1n
  }

  return chunks
}
