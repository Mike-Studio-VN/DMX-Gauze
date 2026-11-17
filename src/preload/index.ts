import { contextBridge, ipcRenderer } from 'electron'
import type { GauzeBridge } from '@shared/api'

const bridge: GauzeBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
}

contextBridge.exposeInMainWorld('gauze', bridge)
