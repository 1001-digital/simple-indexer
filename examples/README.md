# Examples

These are real, runnable indexer examples built on top of `@1001-digital/simple-indexer`.

## Included

- `opepen-artifacts-all-mints.ts` records every ERC-1155 mint on Jalil's Opepen Artifacts contract and keeps basic per-token mint stats
- `opepen-artifacts-balances.ts` maintains current holder balances plus circulating supply per token id

## Running

These files are intentionally plain TypeScript instead of framework-specific templates. Copy one into your app, install `viem`, and point it at your RPC.

Both examples read a few optional environment variables:

- `RPC_URL` RPC endpoint to use
- `CHAIN` `mainnet` or `base` (defaults to `mainnet`)
- `STORE` `memory`, `idb`, or `sqlite` (defaults to `memory`)
- `SQLITE_PATH` path for the SQLite database when `STORE=sqlite`
- `IDB_NAME` IndexedDB database name when `STORE=idb`
- `START_BLOCK` override the contract start block if you know the deployment block

If you do know the deployment block for the contract, set `START_BLOCK` so backfill does not begin at genesis.
