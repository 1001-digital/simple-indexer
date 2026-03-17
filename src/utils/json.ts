/** BigInt-safe JSON replacer — encodes bigints as `__bigint__<value>`. */
export function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `__bigint__${value.toString()}`
  return value
}

/** BigInt-safe JSON reviver — decodes `__bigint__<value>` strings back to bigints. */
export function reviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('__bigint__'))
    return BigInt(value.slice(10))
  return value
}
