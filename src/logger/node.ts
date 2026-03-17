import type { IndexerConfig, IndexerLogger, IndexerStatus, ChunkInfo } from '../types.js'

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
}

function tag(name: string) {
  return `${ansi.cyan}${ansi.bold}[${name}]${ansi.reset}`
}

function label(text: string) {
  return `${ansi.dim}${text}${ansi.reset}`
}

function val(text: string | number | bigint) {
  return `${ansi.white}${ansi.bold}${text}${ansi.reset}`
}

export function createNodeLogger(name: string): Required<IndexerLogger> {
  const t = tag(name)
  let loggedResume = false

  return {
    onStatus(status: IndexerStatus) {
      if (!loggedResume && status.cachedBlocks) {
        loggedResume = true
        console.log(
          `${t} ${ansi.green}${ansi.bold}resuming${ansi.reset} ${label('from block')} ${val(status.startBlock)} ${ansi.dim}(${status.cachedBlocks.toLocaleString()} blocks cached)${ansi.reset}`,
        )
      }

      const phaseColor = status.phase === 'live' ? ansi.green : ansi.yellow
      const pct = status.progress * 100
      const pctColor = pct >= 100 ? ansi.green : pct > 50 ? ansi.yellow : ansi.white
      const done = status.currentBlock - status.startBlock
      const total = status.latestBlock - status.startBlock

      console.log(
        `${t} ${phaseColor}${ansi.bold}${status.phase}${ansi.reset} ${label('block')} ${val(status.currentBlock)}${ansi.dim}/${ansi.reset}${val(status.latestBlock)} ${pctColor}${ansi.bold}${pct.toFixed(3)}%${ansi.reset} ${ansi.dim}(${done}/${total})${ansi.reset}`,
      )

      if (status.error) {
        console.error(`${t} ${ansi.red}${ansi.bold}error:${ansi.reset}`, status.error)
      }
    },

    onChunk(chunk: ChunkInfo) {
      const phaseColor = chunk.phase === 'live' ? ansi.green : chunk.phase === 'gap-fill' ? ansi.cyan : ansi.yellow
      const sourceLabel = chunk.cached
        ? `${ansi.green}cache${ansi.reset}`
        : `${ansi.blue}rpc${ansi.reset}`
      const evtColor = chunk.eventCount > 0 ? ansi.magenta : ansi.dim

      console.log(
        `${t} ${phaseColor}${chunk.phase}${ansi.reset} ${ansi.dim}chunk${ansi.reset} ${val(chunk.from)}${ansi.dim}\u2192${ansi.reset}${val(chunk.to)} ${ansi.dim}size=${ansi.reset}${chunk.size} ${evtColor}events=${chunk.eventCount}${ansi.reset} ${sourceLabel}`,
      )
    },

    onError(error: unknown) {
      console.error(`${t} ${ansi.bgRed}${ansi.white}${ansi.bold} FAILED ${ansi.reset}`)
      console.error(error)
    },
  }
}

export function logStartupNode(name: string, config: IndexerConfig) {
  const t = tag(name)
  const chain = config.client.chain?.name ?? `chain ${config.client.chain?.id ?? '?'}`
  const store = config.store.kind ?? 'unknown'

  console.log(`${t} ${ansi.bold}${ansi.magenta}starting indexer${ansi.reset}`)
  console.log(`${t} ${label('chain')}     ${val(chain)}`)
  console.log(`${t} ${label('store')}     ${val(store)}`)
  for (const [cName, c] of Object.entries(config.contracts)) {
    const addr = Array.isArray(c.address) ? c.address.join(', ') : c.address
    console.log(`${t} ${label('contract')}  ${val(cName)} ${ansi.dim}${addr}${ansi.reset}`)
    if (c.startBlock !== undefined) {
      console.log(`${t} ${label('  start')}   ${val(c.startBlock)}`)
    }
    if (c.endBlock !== undefined) {
      console.log(`${t} ${label('  end')}     ${val(c.endBlock)}`)
    }
  }
  if (config.maxChunkSize !== undefined) {
    console.log(`${t} ${label('max chunk')} ${val(config.maxChunkSize)}`)
  }
  if (config.finalityDepth !== undefined) {
    console.log(`${t} ${label('finality')}  ${val(config.finalityDepth)}`)
  }
}
