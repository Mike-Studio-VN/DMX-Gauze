export const DMX_TRANSPORT_RATES = [25, 30, 40, 50, 60] as const
export const DEFAULT_DMX_TRANSPORT_HZ = DMX_TRANSPORT_RATES[0]

export function normalizeDmxTransportRate(value: unknown): number {
  return DMX_TRANSPORT_RATES.find((rate) => rate === value) ?? DEFAULT_DMX_TRANSPORT_HZ
}

/** Keep the cadence anchored to elapsed time and skip deadlines missed during stalls. */
export function startDmxFrameLoop(hz: number, onFrame: (now: number) => void): () => void {
  const start = performance.now()
  let frame = 1
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const schedule = () => {
    const deadline = start + (frame * 1000) / hz
    timer = setTimeout(() => {
      onFrame(performance.now())
      if (stopped) return
      const elapsed = performance.now() - start
      frame = Math.max(frame + 1, Math.floor((elapsed * hz) / 1000) + 1)
      schedule()
    }, Math.max(1, Math.ceil(deadline - performance.now())))
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
