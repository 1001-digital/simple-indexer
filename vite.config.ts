import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        sqlite: resolve(__dirname, 'src/sqlite.ts'),
        'examples/opepen-artifacts-all-mints': resolve(
          __dirname,
          'examples/opepen-artifacts-all-mints.ts',
        ),
        'examples/opepen-artifacts-balances': resolve(
          __dirname,
          'examples/opepen-artifacts-balances.ts',
        ),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['viem', 'better-sqlite3'],
    },
  },
  plugins: [dts()],
})
