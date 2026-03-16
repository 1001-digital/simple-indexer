import { parseAbi } from 'viem'

export const CONTRACT_ADDRESS =
  '0x03cd89170b64c9f0a392246a2e4a0c22fcd23a5b' as const satisfies `0x${string}`

export const erc1155Abi = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
])
