import { parseAbi } from 'viem'

export const CONTRACT_ADDRESS =
  '0x6ba6f2207e343923ba692e5cae646fb0f566db8d' as const satisfies `0x${string}`

export const cryptoPunksAbi = parseAbi([
  'event Assign(address indexed to, uint256 punkIndex)',
])
