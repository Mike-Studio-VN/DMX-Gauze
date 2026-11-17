import type dgram from 'node:dgram'

const CLOSE_GRACE_MS = 1500

/**
 * Coordinates safe UDP socket shutdown so in-flight `sock.send` calls (including async
 * hostname resolution) complete before `sock.close()` is invoked.
 */
export class UdpSocketLifecycle {
  sock: dgram.Socket | null = null
  ready = false
  closing = false
  private inFlight = 0
  private closeTimer: ReturnType<typeof setTimeout> | null = null

  attach(sock: dgram.Socket): void {
    this.clearCloseTimer()
    this.sock = sock
    this.ready = false
    this.closing = false
    this.inFlight = 0
  }

  markReady(): boolean {
    if (this.closing) {
      this.forceClose()
      return false
    }
    this.ready = true
    return true
  }

  trackSend(fn: (sock: dgram.Socket, done: () => void) => void, onSyncError?: (err: unknown) => void): void {
    const s = this.sock
    if (!s || !this.ready || this.closing) return
    this.inFlight += 1
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      this.inFlight = Math.max(0, this.inFlight - 1)
      if (this.closing && this.inFlight === 0) {
        this.forceClose()
      }
    }
    try {
      fn(s, done)
    } catch (err) {
      done()
      onSyncError?.(err)
    }
  }

  stop(): void {
    this.ready = false
    this.closing = true
    if (!this.sock) return
    if (this.inFlight === 0) {
      this.forceClose()
      return
    }
    this.clearCloseTimer()
    this.closeTimer = setTimeout(() => this.forceClose(), CLOSE_GRACE_MS)
    this.closeTimer.unref?.()
  }

  private clearCloseTimer(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
  }

  private forceClose(): void {
    this.clearCloseTimer()
    this.ready = false
    const s = this.sock
    this.sock = null
    if (s) {
      try {
        s.close()
      } catch {
        /* ignore */
      }
    }
  }
}
