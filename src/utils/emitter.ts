export type Listener<T> = (data: T) => void

export class Emitter<Events extends { [K: string]: unknown }> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(fn as Listener<never>)
    return () => {
      this.listeners.get(event)?.delete(fn as Listener<never>)
    }
  }

  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    this.listeners
      .get(event)
      ?.forEach((fn) => (fn as Listener<Events[K]>)(data))
  }

  clear(): void {
    this.listeners.clear()
  }
}
