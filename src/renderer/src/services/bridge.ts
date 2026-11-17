import type { AppInfo, GauzeBridge, ProjectFileResult, SaveFileResult, SnapshotDto } from '@shared/api'
import { GauzeCore } from '@shared/core'
import { MockDriver } from '@shared/drivers'
import { createDefaultProject, normalizeProject } from '@shared/preset'
import type { Command, CoreConfig, Project } from '@shared/types'

const STORAGE_KEY = 'dmx-gauze-project-v1'

function createWebBridge(): GauzeBridge {
  const listeners = new Set<(s: SnapshotDto) => void>()
  const core = new GauzeCore((_cfg, ev) => new MockDriver(ev, 'Chế độ Web Mock (không gửi UDP)'))
  let webFileName: string | null = null

  core.onSnapshot((snap) => {
    const dto: SnapshotDto = { ...snap, frame: Array.from(snap.frame) }
    for (const cb of listeners) cb(dto)
  })

  const triggerDownload = (project: Project, filename: string) => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return {
    async getAppInfo(): Promise<AppInfo> {
      return { version: '0.1.0', platform: 'web', runtime: 'web' }
    },
    async loadProject(): Promise<ProjectFileResult> {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as Project
          if (parsed && parsed.version === 1 && Array.isArray(parsed.modules) && Array.isArray(parsed.layers)) {
            return { project: normalizeProject(parsed), filePath: webFileName }
          }
        }
      } catch {
        /* ignore */
      }
      return { project: createDefaultProject(), filePath: null }
    },
    async saveProject(project: Project): Promise<void> {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
    },
    async clearCurrentFile(): Promise<void> {
      webFileName = null
    },
    async openProjectFile(): Promise<ProjectFileResult | null> {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'
        input.onchange = async () => {
          const f = input.files?.[0]
          if (!f) return resolve(null)
          try {
            const parsed = JSON.parse(await f.text()) as Project
            if (parsed && parsed.version === 1 && Array.isArray(parsed.modules) && Array.isArray(parsed.layers)) {
              const norm = normalizeProject(parsed)
              localStorage.setItem(STORAGE_KEY, JSON.stringify(norm))
              webFileName = f.name
              resolve({ project: norm, filePath: f.name })
            } else resolve(null)
          } catch {
            resolve(null)
          }
        }
        input.click()
      })
    },
    async saveProjectFile(project: Project): Promise<SaveFileResult> {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
      if (!webFileName) {
        webFileName = 'dmx-gauze-project.json'
        triggerDownload(project, webFileName)
      }
      return { saved: true, filePath: webFileName }
    },
    async saveProjectAs(project: Project): Promise<SaveFileResult> {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
      webFileName = 'dmx-gauze-project.json'
      triggerDownload(project, webFileName)
      return { saved: true, filePath: webFileName }
    },
    async exportProject(project: Project): Promise<boolean> {
      triggerDownload(project, 'dmx-gauze-export.json')
      return true
    },
    async configure(cfg: CoreConfig): Promise<void> {
      core.configure(cfg)
      core.start()
    },
    async command(cmd: Command) {
      return core.command(cmd)
    },
    async pollNow(): Promise<void> {
      core.pollNow()
    },
    async listSerialPorts(): Promise<string[]> {
      return []
    },
    onSnapshot(cb: (snap: SnapshotDto) => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

let cached: GauzeBridge | null = null

export function getBridge(): GauzeBridge {
  if (!cached) cached = window.gauze ?? createWebBridge()
  return cached
}
