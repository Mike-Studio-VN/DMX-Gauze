import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { AppInfo, SnapshotDto } from '@shared/api'
import { GauzeCore } from '@shared/core'
import { MockDriver } from '@shared/drivers'
import type { Command, CoreConfig, Project } from '@shared/types'
import { ArtNetDriver } from './artnetDriver'
import {
  clearCurrentFilePath,
  exportProjectDialog,
  loadSavedProject,
  openProjectDialog,
  saveProjectAsDialog,
  saveProjectFile,
  saveProjectToDisk,
} from './projectStore'

let mainWin: BrowserWindow | null = null

const core = new GauzeCore((cfg, ev) => {
  if (cfg.driver === 'artnet') return new ArtNetDriver(cfg, ev)
  return new MockDriver(ev, 'Đang chạy chế độ mô phỏng (Mock)')
})

core.onSnapshot((snap) => {
  if (!mainWin || mainWin.isDestroyed()) return
  const dto: SnapshotDto = {
    ...snap,
    frame: Array.from(snap.frame),
  }
  mainWin.webContents.send('dmx:snapshot', dto)
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0E1117',
    title: 'DMX Gauze',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  mainWin = win

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('app:info', (): AppInfo => ({
  version: app.getVersion(),
  platform: process.platform,
  runtime: 'electron',
}))
ipcMain.handle('project:load', () => loadSavedProject())
ipcMain.handle('project:save', (_e, p: Project) => saveProjectToDisk(p))
ipcMain.handle('project:clear-file', () => clearCurrentFilePath())
ipcMain.handle('project:open-file', () => openProjectDialog())
ipcMain.handle('project:save-file', (_e, p: Project) => saveProjectFile(p))
ipcMain.handle('project:save-as', (_e, p: Project) => saveProjectAsDialog(p))
ipcMain.handle('project:export', (_e, p: Project) => exportProjectDialog(p))
ipcMain.handle('dmx:configure', (_e, cfg: CoreConfig) => {
  core.configure(cfg)
  core.restartTimer()
})
ipcMain.handle('dmx:command', (_e, cmd: Command) => core.command(cmd))
ipcMain.handle('dmx:poll', () => core.pollNow())

app.whenReady().then(async () => {
  const { project: initial } = await loadSavedProject()
  core.configure({
    modules: initial.modules,
    output: initial.settings.output,
    lockValue: initial.settings.lockValue,
  })
  core.start()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  core.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
