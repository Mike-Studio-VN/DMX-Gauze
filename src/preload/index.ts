import { contextBridge, ipcRenderer } from 'electron'
import type { GauzeBridge, SnapshotDto } from '@shared/api'
import type { Command, CoreConfig, Project } from '@shared/types'

const bridge: GauzeBridge = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  loadProject: () => ipcRenderer.invoke('project:load'),
  saveProject: (p: Project) => ipcRenderer.invoke('project:save', p),
  exportProject: (p: Project) => ipcRenderer.invoke('project:export', p),
  importProject: () => ipcRenderer.invoke('project:import'),
  configure: (cfg: CoreConfig) => ipcRenderer.invoke('dmx:configure', cfg),
  command: (cmd: Command) => ipcRenderer.invoke('dmx:command', cmd),
  pollNow: () => ipcRenderer.invoke('dmx:poll'),
  onSnapshot: (cb: (snap: SnapshotDto) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, snap: SnapshotDto) => cb(snap)
    ipcRenderer.on('dmx:snapshot', handler)
    return () => ipcRenderer.off('dmx:snapshot', handler)
  },
}

contextBridge.exposeInMainWorld('gauze', bridge)
