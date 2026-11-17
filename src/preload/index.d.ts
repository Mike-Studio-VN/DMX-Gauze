import type { GauzeBridge } from '../shared/api'

declare global {
  interface Window {
    gauze?: GauzeBridge
  }
}

export {}
