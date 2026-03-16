import { describe, it, expect, vi } from 'vitest'
import { Emitter } from '../src/utils/emitter'

describe('Emitter', () => {
  it('calls listeners on emit', () => {
    const emitter = new Emitter<{ test: string }>()
    const fn = vi.fn()
    emitter.on('test', fn)
    emitter.emit('test', 'hello')
    expect(fn).toHaveBeenCalledWith('hello')
  })

  it('supports multiple listeners', () => {
    const emitter = new Emitter<{ test: number }>()
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    emitter.on('test', fn1)
    emitter.on('test', fn2)
    emitter.emit('test', 42)
    expect(fn1).toHaveBeenCalledWith(42)
    expect(fn2).toHaveBeenCalledWith(42)
  })

  it('returns unsubscribe function', () => {
    const emitter = new Emitter<{ test: string }>()
    const fn = vi.fn()
    const unsub = emitter.on('test', fn)
    unsub()
    emitter.emit('test', 'hello')
    expect(fn).not.toHaveBeenCalled()
  })

  it('does not error when emitting with no listeners', () => {
    const emitter = new Emitter<{ test: string }>()
    expect(() => emitter.emit('test', 'hello')).not.toThrow()
  })

  it('clear removes all listeners', () => {
    const emitter = new Emitter<{ a: string; b: number }>()
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    emitter.on('a', fn1)
    emitter.on('b', fn2)
    emitter.clear()
    emitter.emit('a', 'x')
    emitter.emit('b', 1)
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).not.toHaveBeenCalled()
  })
})
