import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindowConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectFileResult } from '@shared/api'
import { createDefaultProject, normalizeProject } from '@shared/preset'

interface TestWindow {
  options: BrowserWindowConstructorOptions
  webContents: object
  emit(event: string): void
  close(): void
  show: ReturnType<typeof vi.fn>
  minimize: ReturnType<typeof vi.fn>
  maximize: ReturnType<typeof vi.fn>
  unmaximize: ReturnType<typeof vi.fn>
}

type IpcHandler = (event: { sender: object }, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  userData: '',
  windows: [] as TestWindow[],
  handlers: new Map<string, IpcHandler>(),
  openDialog: vi.fn(),
  startTransport: vi.fn(),
  stopTransport: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow extends EventEmitter {
    webContents = { setWindowOpenHandler: vi.fn() }
    show = vi.fn()
    minimize = vi.fn()
    maximize = vi.fn(() => { this.maximized = true })
    unmaximize = vi.fn(() => { this.maximized = false })
    isMaximized = () => this.maximized
    private maximized = false
    loadFile = vi.fn(async () => {})
    loadURL = vi.fn(async () => {})
    isDestroyed = () => this.destroyed
    private destroyed = false

    constructor(readonly options: BrowserWindowConstructorOptions) {
      super()
      state.windows.push(this)
    }

    close() {
      this.destroyed = true
      this.emit('closed')
    }

    destroy() {
      this.close()
    }
  }

  return {
    app: {
      whenReady: async () => {},
      getAppPath: () => '.',
      getPath: () => state.userData,
      on: vi.fn(),
    },
    BrowserWindow,
    dialog: { showOpenDialog: state.openDialog },
    ipcMain: { handle: (name: string, handler: IpcHandler) => state.handlers.set(name, handler) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    shell: {},
  }
})

vi.mock('@shared/core', () => ({
  GauzeCore: class {
    onSnapshot = vi.fn()
    start = state.startTransport
    stop = state.stopTransport
  },
}))

const invoke = <T>(window: TestWindow, name: string, ...args: unknown[]) =>
  state.handlers.get(name)!({ sender: window.webContents }, ...args) as T

describe('Electron project choice at startup', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    state.windows.length = 0
    state.handlers.clear()
    state.userData = await mkdtemp(join(tmpdir(), 'dmx-gauze-startup-'))
  })

  afterEach(async () => {
    await rm(state.userData, { recursive: true, force: true })
  })

  it('keeps transport idle until a blank project is chosen and saved', async () => {
    await import('./index')
    const [picker] = state.windows
    expect(state.windows).toHaveLength(1)
    expect(picker.options.webPreferences?.additionalArguments).toContain('--gauze-startup')
    expect(state.startTransport).not.toHaveBeenCalled()
    await expect(invoke(picker, 'startup:has-recent')).resolves.toBe(false)
    await expect(invoke(picker, 'startup:choose', 'recent')).resolves.toBe(false)
    expect(state.windows).toHaveLength(1)

    await expect(invoke(picker, 'startup:choose', 'new')).resolves.toBe(true)
    expect(state.windows).toHaveLength(2)
    const editor = state.windows[1]
    const result = invoke<ProjectFileResult>(editor, 'project:load')
    expect(result.filePath).toBeNull()
    expect(result.project.modules).toHaveLength(1)
    expect(JSON.parse(await readFile(join(state.userData, 'project.json'), 'utf8'))).toEqual(normalizeProject(result.project))
    expect(state.startTransport).not.toHaveBeenCalled()

    editor.emit('ready-to-show')
    expect(editor.show).toHaveBeenCalledOnce()
    expect(state.startTransport).toHaveBeenCalledOnce()
    editor.close()
    expect(state.stopTransport).toHaveBeenCalledOnce()
  })

  it('routes native window controls only to the startup picker', async () => {
    await import('./index')
    const [picker] = state.windows
    expect(picker.options.frame).toBe(false)
    const windowAction = state.handlers.get('startup:window-action')!
    windowAction({ sender: {} }, 'minimize')
    expect(picker.minimize).not.toHaveBeenCalled()

    invoke(picker, 'startup:window-action', 'minimize')
    invoke(picker, 'startup:window-action', 'toggle-maximize')
    invoke(picker, 'startup:window-action', 'toggle-maximize')
    expect(picker.minimize).toHaveBeenCalledOnce()
    expect(picker.maximize).toHaveBeenCalledOnce()
    expect(picker.unmaximize).toHaveBeenCalledOnce()
    invoke(picker, 'startup:window-action', 'close')
    await expect(invoke(picker, 'startup:has-recent')).resolves.toBe(false)
    expect(state.startTransport).not.toHaveBeenCalled()
  })

  it('uses the validated autosave when choosing the recent project', async () => {
    const saved = createDefaultProject()
    saved.modules[0].name = 'Autosave'
    await writeFile(join(state.userData, 'project.json'), JSON.stringify(saved))
    await import('./index')
    const [picker] = state.windows

    await expect(invoke(picker, 'startup:has-recent')).resolves.toBe(true)
    await expect(invoke(picker, 'startup:choose', 'recent')).resolves.toBe(true)
    expect(invoke(state.windows[1], 'project:load')).toMatchObject({ project: saved, filePath: null })
  })

  it('stays in the picker on cancel or invalid JSON and preserves the path of a valid file', async () => {
    await import('./index')
    const [picker] = state.windows
    state.openDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(invoke(picker, 'startup:choose', 'open')).resolves.toBe(false)

    const filePath = join(state.userData, 'cue.mikdmx')
    await writeFile(filePath, '{}')
    state.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] })
    await expect(invoke(picker, 'startup:choose', 'open')).rejects.toThrow()
    expect(state.windows).toHaveLength(1)
    expect(state.startTransport).not.toHaveBeenCalled()
    expect(state.openDialog).toHaveBeenCalledWith(picker, expect.any(Object))

    const project = createDefaultProject()
    project.modules[0].name = 'Opened project'
    await writeFile(filePath, JSON.stringify(project))
    state.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] })
    await expect(invoke(picker, 'startup:choose', 'open')).resolves.toBe(true)
    const editor = state.windows[1]
    expect(invoke(editor, 'project:load')).toMatchObject({ project, filePath })
    expect(invoke(editor, 'project:load')).toMatchObject({ project, filePath })
    await expect(invoke(editor, 'project:save-file', project)).resolves.toMatchObject({ filePath, saved: true })
  })
})
