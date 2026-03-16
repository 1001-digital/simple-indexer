import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'
import { readdirSync } from 'fs'

const exampleEntries = Object.fromEntries(
  readdirSync('examples')
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
    .map((f) => [
      `examples/${f.replace('.ts', '')}`,
      resolve(__dirname, `examples/${f}`),
    ]),
)

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        sqlite: resolve(__dirname, 'src/sqlite.ts'),
        ...exampleEntries,
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['viem', 'better-sqlite3', 'fs', 'path', 'url', 'node:util'],
    },
  },
  plugins: [
    dts({ tsconfigPath: './tsconfig.typecheck.json', include: ['src'] }),
  ],
})
