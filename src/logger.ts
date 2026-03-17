import type { IndexerConfig, IndexerLogger, IndexerStatus, ChunkInfo } from './types.js'

type Env = 'node' | 'browser'

function detectEnv(): Env {
  if (
    typeof window !== 'undefined' &&
    typeof window.document !== 'undefined'
  ) {
    return 'browser'
  }
  return 'node'
}

// ---------------------------------------------------------------------------
// Node logger (ANSI escape codes)
// ---------------------------------------------------------------------------

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

function nodeTag(name: string) {
  return `${ansi.cyan}${ansi.bold}[${name}]${ansi.reset}`
}

function nodeLabel(text: string) {
  return `${ansi.dim}${text}${ansi.reset}`
}

function nodeVal(text: string | number | bigint) {
  return `${ansi.white}${ansi.bold}${text}${ansi.reset}`
}

function createNodeLogger(name: string): Required<IndexerLogger> {
  const t = nodeTag(name)
  let loggedResume = false

  return {
    onStatus(status: IndexerStatus) {
      if (!loggedResume && status.cachedBlocks) {
        loggedResume = true
        console.log(
          `${t} ${ansi.green}${ansi.bold}resuming${ansi.reset} ${nodeLabel('from block')} ${nodeVal(status.startBlock)} ${ansi.dim}(${status.cachedBlocks.toLocaleString()} blocks cached)${ansi.reset}`,
        )
      }

      const phaseColor = status.phase === 'live' ? ansi.green : ansi.yellow
      const pct = status.progress * 100
      const pctColor = pct >= 100 ? ansi.green : pct > 50 ? ansi.yellow : ansi.white
      const done = status.currentBlock - status.startBlock
      const total = status.latestBlock - status.startBlock

      console.log(
        `${t} ${phaseColor}${ansi.bold}${status.phase}${ansi.reset} ${nodeLabel('block')} ${nodeVal(status.currentBlock)}${ansi.dim}/${ansi.reset}${nodeVal(status.latestBlock)} ${pctColor}${ansi.bold}${pct.toFixed(3)}%${ansi.reset} ${ansi.dim}(${done}/${total})${ansi.reset}`,
      )

      if (status.error) {
        console.error(`${t} ${ansi.red}${ansi.bold}error:${ansi.reset}`, status.error)
      }
    },

    onChunk(chunk: ChunkInfo) {
      const phaseColor = chunk.phase === 'live' ? ansi.green : ansi.yellow
      const sourceLabel = chunk.cached
        ? `${ansi.green}cache${ansi.reset}`
        : `${ansi.blue}rpc${ansi.reset}`
      const evtColor = chunk.eventCount > 0 ? ansi.magenta : ansi.dim

      console.log(
        `${t} ${phaseColor}${chunk.phase}${ansi.reset} ${ansi.dim}chunk${ansi.reset} ${nodeVal(chunk.from)}${ansi.dim}\u2192${ansi.reset}${nodeVal(chunk.to)} ${ansi.dim}size=${ansi.reset}${chunk.size} ${evtColor}events=${chunk.eventCount}${ansi.reset} ${sourceLabel}`,
      )
    },

    onError(error: unknown) {
      console.error(`${t} ${ansi.bgRed}${ansi.white}${ansi.bold} FAILED ${ansi.reset}`)
      console.error(error)
    },
  }
}

// ---------------------------------------------------------------------------
// Browser logger (%c CSS styling)
// ---------------------------------------------------------------------------

const css = {
  tag: 'color:#06b6d4;font-weight:bold',
  dim: 'color:#6b7280',
  val: 'color:#f3f4f6;font-weight:bold',
  reset: '',
  green: 'color:#22c55e;font-weight:bold',
  yellow: 'color:#eab308;font-weight:bold',
  white: 'color:#f3f4f6;font-weight:bold',
  blue: 'color:#3b82f6',
  magenta: 'color:#a855f7',
  red: 'color:#ef4444;font-weight:bold',
  error: 'background:#ef4444;color:white;font-weight:bold;padding:1px 6px;border-radius:3px',
}

function createBrowserLogger(name: string): Required<IndexerLogger> {
  const tagFmt = `%c[${name}]%c `
  let loggedResume = false

  return {
    onStatus(status: IndexerStatus) {
      if (!loggedResume && status.cachedBlocks) {
        loggedResume = true
        console.log(
          `${tagFmt}%cresuming%c from block %c${status.startBlock}%c (${status.cachedBlocks.toLocaleString()} blocks cached)`,
          css.tag, css.reset,
          css.green, css.reset,
          css.val, css.dim,
        )
      }

      const pct = status.progress * 100
      const phaseStyle = status.phase === 'live' ? css.green : css.yellow
      const pctStyle = pct >= 100 ? css.green : pct > 50 ? css.yellow : css.white
      const done = status.currentBlock - status.startBlock
      const total = status.latestBlock - status.startBlock

      console.log(
        `${tagFmt}%c${status.phase}%c block %c${status.currentBlock}%c/%c${status.latestBlock}%c %c${pct.toFixed(3)}%%c (${done}/${total})`,
        css.tag, css.reset,
        phaseStyle, css.reset,
        css.val, css.dim, css.val, css.reset,
        pctStyle, css.dim,
      )

      if (status.error) {
        console.error(
          `${tagFmt}%cerror:`,
          css.tag, css.reset,
          css.red,
          status.error,
        )
      }
    },

    onChunk(chunk: ChunkInfo) {
      const phaseStyle = chunk.phase === 'live' ? css.green : css.yellow
      const sourceStyle = chunk.cached ? css.green : css.blue
      const sourceText = chunk.cached ? 'cache' : 'rpc'
      const evtStyle = chunk.eventCount > 0 ? css.magenta : css.dim

      console.log(
        `${tagFmt}%c${chunk.phase}%c chunk %c${chunk.from}%c\u2192%c${chunk.to}%c size=${chunk.size} %cevents=${chunk.eventCount}%c %c${sourceText}`,
        css.tag, css.reset,
        phaseStyle, css.reset,
        css.val, css.dim, css.val, css.reset,
        evtStyle, css.reset,
        sourceStyle,
      )
    },

    onError(error: unknown) {
      console.error(
        `${tagFmt}%c FAILED `,
        css.tag, css.reset,
        css.error,
      )
      console.error(error)
    },
  }
}

// ---------------------------------------------------------------------------
// Startup config log
// ---------------------------------------------------------------------------

function logStartupNode(name: string, config: IndexerConfig) {
  const t = nodeTag(name)
  const chain = config.client.chain?.name ?? `chain ${config.client.chain?.id ?? '?'}`
  const store = config.store.kind ?? 'unknown'
  const contracts = Object.entries(config.contracts)

  console.log(`${t} ${ansi.bold}${ansi.magenta}starting indexer${ansi.reset}`)
  console.log(`${t} ${nodeLabel('chain')}     ${nodeVal(chain)}`)
  console.log(`${t} ${nodeLabel('store')}     ${nodeVal(store)}`)
  for (const [cName, c] of contracts) {
    const addr = Array.isArray(c.address) ? c.address.join(', ') : c.address
    console.log(`${t} ${nodeLabel('contract')}  ${nodeVal(cName)} ${ansi.dim}${addr}${ansi.reset}`)
    if (c.startBlock !== undefined) {
      console.log(`${t} ${nodeLabel('  start')}   ${nodeVal(c.startBlock)}`)
    }
    if (c.endBlock !== undefined) {
      console.log(`${t} ${nodeLabel('  end')}     ${nodeVal(c.endBlock)}`)
    }
  }
  if (config.maxChunkSize !== undefined) {
    console.log(`${t} ${nodeLabel('chunk')}     ${nodeVal(config.maxChunkSize)}`)
  }
  if (config.finalityDepth !== undefined) {
    console.log(`${t} ${nodeLabel('finality')}  ${nodeVal(config.finalityDepth)}`)
  }
}

function logStartupBrowser(name: string, config: IndexerConfig) {
  const tagFmt = `%c[${name}]%c `
  const chain = config.client.chain?.name ?? `chain ${config.client.chain?.id ?? '?'}`
  const store = config.store.kind ?? 'unknown'
  const contracts = Object.entries(config.contracts)

  console.log(
    `${tagFmt}%cstarting indexer`,
    css.tag, css.reset, 'color:#a855f7;font-weight:bold',
  )
  console.log(`${tagFmt}chain %c${chain}`, css.tag, css.reset, css.val)
  console.log(`${tagFmt}store %c${store}`, css.tag, css.reset, css.val)
  for (const [cName, c] of contracts) {
    const addr = Array.isArray(c.address) ? c.address.join(', ') : c.address
    console.log(
      `${tagFmt}contract %c${cName}%c ${addr}`,
      css.tag, css.reset, css.val, css.dim,
    )
    if (c.startBlock !== undefined) {
      console.log(`${tagFmt}  start %c${c.startBlock}`, css.tag, css.reset, css.val)
    }
    if (c.endBlock !== undefined) {
      console.log(`${tagFmt}  end %c${c.endBlock}`, css.tag, css.reset, css.val)
    }
  }
  if (config.maxChunkSize !== undefined) {
    console.log(`${tagFmt}chunk %c${config.maxChunkSize}`, css.tag, css.reset, css.val)
  }
  if (config.finalityDepth !== undefined) {
    console.log(`${tagFmt}finality %c${config.finalityDepth}`, css.tag, css.reset, css.val)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createLogger(
  name: string,
  env?: Env,
): Required<IndexerLogger> {
  const e = env ?? detectEnv()
  if (e === 'browser') return createBrowserLogger(name)
  return createNodeLogger(name)
}

export function logStartup(
  name: string,
  config: IndexerConfig,
  env?: Env,
) {
  const e = env ?? detectEnv()
  if (e === 'browser') logStartupBrowser(name, config)
  else logStartupNode(name, config)
}
