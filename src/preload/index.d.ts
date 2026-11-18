import type { GauzeBridge, StartupBridge } from '../shared/api'

declare global {
  interface Window {
    gauze?: GauzeBridge
    gauzeStartup?: StartupBridge
  }
}

export {}
