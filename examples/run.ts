import { readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    store: { type: 'string' },
  },
  allowPositionals: true,
})

const name = positionals[0]
const dir = dirname(fileURLToPath(import.meta.url))

const examples = readdirSync(dir)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'run.js')
  .map((f) => f.replace('.js', ''))

if (!name || !examples.includes(name)) {
  console.error(`Usage: node run.js <example> [--store=memory|sqlite|idb]\n`)
  console.error(`Available examples:`)
  for (const e of examples) {
    console.error(`  ${e}`)
  }
  process.exit(1)
}

if (values.store) {
  process.env.STORE = values.store
}

import(resolve(dir, `${name}.js`)).catch((err) => {
  console.error(err)
  process.exit(1)
})
