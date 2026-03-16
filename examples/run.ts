import { readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const name = process.argv[2]
const dir = dirname(fileURLToPath(import.meta.url))

const examples = readdirSync(dir)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'run.js')
  .map((f) => f.replace('.js', ''))

if (!name || !examples.includes(name)) {
  console.error(`Usage: node run.js <example>\n`)
  console.error(`Available examples:`)
  for (const e of examples) {
    console.error(`  ${e}`)
  }
  process.exit(1)
}

import(resolve(dir, `${name}.js`)).catch((err) => {
  console.error(err)
  process.exit(1)
})
