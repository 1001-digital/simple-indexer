import type { IndexerConfig, IndexerLogger, IndexerStatus, ChunkInfo } from '../types.js'

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

export function createBrowserLogger(name: string): Required<IndexerLogger> {
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
      const phaseStyle = chunk.phase === 'live' ? css.green : chunk.phase === 'gap-fill' ? 'color:#06b6d4;font-weight:bold' : css.yellow
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

export function logStartupBrowser(name: string, config: IndexerConfig) {
  const tagFmt = `%c[${name}]%c `
  const chain = config.client.chain?.name ?? `chain ${config.client.chain?.id ?? '?'}`
  const store = config.store.kind ?? 'unknown'

  console.log(
    `${tagFmt}%cstarting indexer`,
    css.tag, css.reset, 'color:#a855f7;font-weight:bold',
  )
  console.log(`${tagFmt}chain %c${chain}`, css.tag, css.reset, css.val)
  console.log(`${tagFmt}store %c${store}`, css.tag, css.reset, css.val)
  for (const [cName, c] of Object.entries(config.contracts)) {
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
    console.log(`${tagFmt}max chunk %c${config.maxChunkSize}`, css.tag, css.reset, css.val)
  }
  if (config.finalityDepth !== undefined) {
    console.log(`${tagFmt}finality %c${config.finalityDepth}`, css.tag, css.reset, css.val)
  }
}
