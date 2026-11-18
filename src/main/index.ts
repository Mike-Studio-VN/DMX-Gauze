import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import type { AppInfo, ProjectFileResult, SnapshotDto } from '@shared/api'
import { GauzeCore } from '@shared/core'
import { MockDriver } from '@shared/drivers'
import { createBlankProject } from '@shared/preset'
import type { Command, CoreConfig, Project } from '@shared/types'
import { ArtNetDriver } from './artnetDriver'
import { KinetDriver } from './kinetDriver'
import {
  clearCurrentFilePath,
  exportProjectDialog,
  loadSavedProject,
  openProjectDialog,
  saveProjectAsDialog,
  saveProjectFile,
  saveProjectToDisk,
} from './projectStore'
import { SacnDriver } from './sacnDriver'
import { SerialDmxDriver, listSerialPorts } from './serialDriver'

interface StartupWindow {
  win: BrowserWindow
  recent: ReturnType<typeof loadSavedProject>
  selecting: boolean
}

let mainWin: BrowserWindow | null = null
let startup: StartupWindow | null = null
let launchProject: ProjectFileResult | null = null

const core = new GauzeCore((cfg, ev) => {
  switch (cfg.driver) {
    case 'artnet':
      return new ArtNetDriver(cfg, ev)
    case 'sacn':
      return new SacnDriver(cfg, ev)
    case 'kinet':
      return new KinetDriver(cfg, ev)
    case 'enttec-pro':
    case 'enttec-mk2':
    case 'serial':
      return new SerialDmxDriver(cfg, ev)
    default:
      return new MockDriver(ev, 'Đang chạy chế độ mô phỏng (Mock)')
  }
})

core.onSnapshot((snap) => {
  if (!mainWin || mainWin.isDestroyed()) return
  const dto: SnapshotDto = {
    ...snap,
    frame: Array.from(snap.frame),
  }
  mainWin.webContents.send('dmx:snapshot', dto)
})

function resolveAppIcon() {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  const img = nativeImage.createFromPath(iconPath)
  return img.isEmpty() ? undefined : img
}

function loadRenderer(win: BrowserWindow): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) {
    return win.loadURL(process.env.ELECTRON_RENDERER_URL)
  }
  return win.loadFile(join(__dirname, '../renderer/index.html'))
}

function createStartupWindow(): void {
  if (startup || mainWin) return
  const icon = resolveAppIcon()
  const win = new BrowserWindow({
    width: 504,
    height: 284,
    minWidth: 480,
    minHeight: 270,
    frame: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#171312',
    title: 'DMX Gauze',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      additionalArguments: ['--gauze-startup'],
    },
  })
  const session = { win, recent: loadSavedProject(), selecting: false }
  startup = session
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (startup === session) startup = null
  })
  void loadRenderer(win).catch((err: unknown) => {
    console.error('Không mở được cửa sổ khởi động DMX Gauze:', err)
    if (!win.isDestroyed()) win.destroy()
  })
}

async function createMainWindow(initial: ProjectFileResult, picker: StartupWindow): Promise<void> {
  const icon = resolveAppIcon()
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0E1117',
    title: 'DMX Gauze',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      // Tiếp tục phát timeline khi cửa sổ thu nhỏ hoặc bị che.
      backgroundThrottling: false,
    },
  })
  mainWin = win
  launchProject = initial

  win.once('ready-to-show', () => {
    core.start()
    win.show()
    if (!picker.win.isDestroyed()) picker.win.close()
  })
  win.on('closed', () => {
    if (mainWin !== win) return
    mainWin = null
    launchProject = null
    core.stop()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  try {
    await loadRenderer(win)
  } catch (err) {
    if (!win.isDestroyed()) win.destroy()
    throw err
  }
}

ipcMain.handle('app:info', (): AppInfo => ({
  version: app.getVersion(),
  platform: process.platform,
  runtime: 'electron',
}))
ipcMain.handle('startup:has-recent', async ({ sender }) => {
  const picker = startup
  return picker?.win.webContents === sender && (await picker.recent).hasAutosave
})
ipcMain.handle('startup:window-action', ({ sender }, action: unknown) => {
  const win = startup?.win
  if (win?.webContents !== sender) return

  switch (action) {
    case 'minimize':
      win.minimize()
      break
    case 'toggle-maximize':
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      break
    case 'close':
      win.close()
      break
  }
})
ipcMain.handle('startup:choose', async ({ sender }, choice: unknown) => {
  const picker = startup
  if (picker?.win.webContents !== sender || picker.selecting || mainWin) return false

  picker.selecting = true
  try {
    let initial: ProjectFileResult | null
    switch (choice) {
      case 'recent': {
        const recent = await picker.recent
        initial = recent.hasAutosave ? recent : null
        break
      }
      case 'new': {
        const recent = await picker.recent
        const project = createBlankProject(recent.hasAutosave ? recent.project.settings : undefined)
        await saveProjectToDisk(project)
        clearCurrentFilePath()
        initial = { project, filePath: null }
        break
      }
      case 'open':
        initial = await openProjectDialog(picker.win)
        break
      default:
        return false
    }

    if (!initial || startup !== picker) return false
    await createMainWindow(initial, picker)
    return true
  } finally {
    picker.selecting = false
  }
})
ipcMain.handle('project:load', () => launchProject ?? loadSavedProject())
ipcMain.handle('project:save', (_e, p: Project) => saveProjectToDisk(p))
ipcMain.handle('project:clear-file', () => clearCurrentFilePath())
ipcMain.handle('project:open-file', () => openProjectDialog())
ipcMain.handle('project:save-file', (_e, p: Project) => saveProjectFile(p))
ipcMain.handle('project:save-as', (_e, p: Project) => saveProjectAsDialog(p))
ipcMain.handle('project:export', (_e, p: Project) => exportProjectDialog(p))
ipcMain.handle('dmx:configure', (_e, cfg: CoreConfig) => {
  core.configure(cfg)
})
ipcMain.handle('dmx:command', (_e, cmd: Command) => core.command(cmd))
ipcMain.handle('dmx:poll', () => core.pollNow())
ipcMain.handle('dmx:list-serial', () => listSerialPorts())

app.whenReady().then(() => {
  const icon = resolveAppIcon()
  if (process.platform === 'darwin' && icon) {
    app.dock?.setIcon(icon)
  }
  createStartupWindow()
  app.on('activate', createStartupWindow)
})

app.on('before-quit', () => {
  core.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
