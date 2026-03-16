# Examples

These are real, runnable indexer examples built on top of `@1001-digital/simple-indexer`.

## Included

- `opepen-artifacts-all-mints.ts` records every ERC-1155 mint on Jalil's Opepen Artifacts contract and keeps basic per-token mint stats
- `opepen-artifacts-balances.ts` maintains current holder balances plus circulating supply per token id

## Running

1. Copy `.env.example` to `.env`
2. Fill in `RPC_URL` and any overrides you want
3. Run one of:

```sh
pnpm example:mints
pnpm example:balances
```

These scripts build the repo and run the compiled examples from `dist/examples/`.

Both examples read a few optional environment variables:

- `RPC_URL` RPC endpoint to use
- `CHAIN` `mainnet` or `base` (defaults to `mainnet`)
- `STORE` `memory`, `idb`, or `sqlite` (defaults to `memory`)
- `SQLITE_PATH` path for the SQLite database when `STORE=sqlite`
- `IDB_NAME` IndexedDB database name when `STORE=idb`
- `START_BLOCK` override the contract start block if you know the deployment block
- `END_BLOCK` stop indexing at this block — the indexer will backfill up to this block and skip live sync

If you do know the deployment block for the contract, set `START_BLOCK` so backfill does not begin at genesis. Set `END_BLOCK` if you only need a fixed block range (e.g. a historical snapshot).
