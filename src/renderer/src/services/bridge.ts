import type { AppInfo, GauzeBridge, ProjectFileResult, SaveFileResult, SnapshotDto } from '@shared/api'
import { GauzeCore } from '@shared/core'
import { MockDriver } from '@shared/drivers'
import { createDefaultProject, normalizeProject } from '@shared/preset'
import type { Command, CoreConfig, Project } from '@shared/types'

const STORAGE_KEY = 'dmx-gauze-project-v1'

interface WebWritableFile {
  write: (data: string) => Promise<void>
  close: () => Promise<void>
}

interface WebFileHandle {
  name: string
  createWritable: () => Promise<WebWritableFile>
}

type WindowWithFs = Window & {
  showSaveFilePicker?: (opts?: {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<WebFileHandle>
}

export function createWebBridge(): GauzeBridge {
  const listeners = new Set<(s: SnapshotDto) => void>()
  const core = new GauzeCore((_cfg, ev) => new MockDriver(ev, 'Chế độ Web Mock (không gửi UDP)'))
  let webFileName: string | null = null
  let webFileHandle: WebFileHandle | null = null

  core.onSnapshot((snap) => {
    const dto: SnapshotDto = { ...snap, frame: Array.from(snap.frame) }
    for (const cb of listeners) cb(dto)
  })

  const triggerDownload = (json: string, filename: string) => {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const writeToHandle = async (handle: WebFileHandle, json: string): Promise<void> => {
    const writable = await handle.createWritable()
    await writable.write(json)
    await writable.close()
  }

  // Cache best-effort cho mở/lưu file; chỉ autosave (saveProject) coi localStorage là đích lưu nên mới ném lỗi.
  const persistLocal = (json: string): void => {
    try {
      localStorage.setItem(STORAGE_KEY, json)
    } catch {
      /* ignore */
    }
  }

  const saveViaPickerOrDownload = async (json: string, suggestedName: string): Promise<SaveFileResult> => {
    const picker = typeof window !== 'undefined' ? (window as WindowWithFs).showSaveFilePicker : undefined
    if (picker) {
      try {
        const handle = await picker({
          suggestedName,
          types: [{ description: 'DMX Gauze Project', accept: { 'application/json': ['.json'] } }],
        })
        await writeToHandle(handle, json)
        webFileHandle = handle
        webFileName = handle.name || suggestedName
        return { saved: true, filePath: webFileName }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          return { saved: false, filePath: webFileName }
        }
        // Fallback sang tải file thực sự nếu không dùng được picker (vd: không có user gesture / permission)
      }
    }
    webFileHandle = null
    webFileName = suggestedName
    triggerDownload(json, suggestedName)
    return { saved: true, filePath: suggestedName }
  }

  return {
    async getAppInfo(): Promise<AppInfo> {
      return { version: '1.0.7', platform: 'web', runtime: 'web' }
    },
    async loadProject(): Promise<ProjectFileResult> {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) {
          const parsed: unknown = JSON.parse(raw)
          const project = normalizeProject(parsed)
          const rawPort = (parsed as { settings?: { output?: { port?: unknown } } })?.settings?.output?.port
          if (rawPort !== project.settings.output.port) {
            persistLocal(JSON.stringify(project))
          }
          return { project, filePath: webFileName }
        }
      } catch {
        /* ignore */
      }
      return { project: createDefaultProject(), filePath: null }
    },
    async saveProject(project: Project): Promise<void> {
      const validated = normalizeProject(project)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(validated))
    },
    async clearCurrentFile(): Promise<void> {
      webFileName = null
      webFileHandle = null
    },
    async openProjectFile(): Promise<ProjectFileResult | null> {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'
        input.onchange = async () => {
          const f = input.files?.[0]
          if (!f) return resolve(null)
          try {
            const parsed: unknown = JSON.parse(await f.text())
            const norm = normalizeProject(parsed)
            persistLocal(JSON.stringify(norm))
            webFileHandle = null
            webFileName = f.name
            resolve({ project: norm, filePath: f.name })
          } catch (err) {
            reject(err instanceof Error ? err : new Error('File dự án không hợp lệ'))
          }
        }
        input.click()
      })
    },
    async saveProjectFile(project: Project): Promise<SaveFileResult> {
      const validated = normalizeProject(project)
      const json = JSON.stringify(validated, null, 2)
      if (webFileHandle) {
        // Lỗi ghi (quyền, đĩa đầy...) phải nổi lên để store hiện toast lỗi, không nuốt thành saved:false.
        await writeToHandle(webFileHandle, json)
        persistLocal(json)
        return { saved: true, filePath: webFileName }
      }
      persistLocal(json)
      const targetName = webFileName ?? 'dmx-gauze-project.json'
      webFileName = targetName
      triggerDownload(json, targetName)
      return { saved: true, filePath: targetName }
    },
    async saveProjectAs(project: Project): Promise<SaveFileResult> {
      const validated = normalizeProject(project)
      const json = JSON.stringify(validated, null, 2)
      persistLocal(json)
      return saveViaPickerOrDownload(json, webFileName ?? 'dmx-gauze-project.json')
    },
    async exportProject(project: Project): Promise<boolean> {
      const validated = normalizeProject(project)
      triggerDownload(JSON.stringify(validated, null, 2), 'dmx-gauze-export.json')
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
