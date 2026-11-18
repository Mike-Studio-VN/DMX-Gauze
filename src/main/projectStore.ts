import { app, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ProjectFileResult, SaveFileResult } from '@shared/api'
import { createDefaultProject, normalizeProject, projectFileName } from '@shared/preset'
import type { Project } from '@shared/types'

let currentFilePath: string | null = null

function defaultFilePath(): string {
  return join(app.getPath('userData'), 'project.json')
}

function serializeProject(project: Project): string {
  return JSON.stringify(normalizeProject(project), null, 2)
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath)
  await mkdir(dir, { recursive: true })
  const tmpPath = join(
    dir,
    `.${basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  try {
    await writeFile(tmpPath, content, 'utf8')
    await rename(tmpPath, targetPath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

/** Cập nhật bản cache autosave best-effort sau khi file chính đã ghi thành công. */
async function syncAutosaveCache(json: string): Promise<void> {
  try {
    await atomicWriteText(defaultFilePath(), json)
  } catch (err) {
    console.warn('[projectStore] Không thể cập nhật cache tự động lưu sau khi đã lưu file chính:', err)
  }
}

export function parseProjectJson(raw: string): Project {
  const parsed: unknown = JSON.parse(raw)
  return normalizeProject(parsed)
}

export async function loadSavedProject(): Promise<ProjectFileResult & { hasAutosave: boolean }> {
  currentFilePath = null
  try {
    const raw = await readFile(defaultFilePath(), 'utf8')
    const project = parseProjectJson(raw)
    try {
      const parsed = JSON.parse(raw) as { settings?: { output?: { port?: unknown } } }
      if (parsed?.settings?.output?.port !== project.settings.output.port) {
        await syncAutosaveCache(serializeProject(project))
      }
    } catch {
      /* ignore */
    }
    return { project, filePath: null, hasAutosave: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[projectStore] File dự án tự động lưu bị hỏng hoặc thiếu cấu trúc, khôi phục preset mặc định:', err)
    }
  }
  return { project: createDefaultProject(), filePath: null, hasAutosave: false }
}

export async function saveProjectToDisk(project: Project): Promise<void> {
  await atomicWriteText(defaultFilePath(), serializeProject(project))
}

export function clearCurrentFilePath(): void {
  currentFilePath = null
}

export async function openProjectDialog(parent?: BrowserWindow): Promise<ProjectFileResult | null> {
  const options: OpenDialogOptions = {
    title: 'Mở dự án DMX Gauze',
    properties: ['openFile'],
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  }
  const res = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (res.canceled || !res.filePaths[0]) return null
  const filePath = res.filePaths[0]
  const raw = await readFile(filePath, 'utf8')
  const project = parseProjectJson(raw)
  const json = serializeProject(project)
  currentFilePath = filePath
  await syncAutosaveCache(json)
  return { project, filePath }
}

export async function saveProjectAsDialog(project: Project): Promise<SaveFileResult> {
  const json = serializeProject(project)
  const res = await dialog.showSaveDialog({
    title: 'Lưu dự án DMX Gauze thành...',
    defaultPath: currentFilePath ?? projectFileName(project.name),
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePath) return { saved: false, filePath: currentFilePath }
  const targetPath = res.filePath
  await atomicWriteText(targetPath, json)
  currentFilePath = targetPath
  await syncAutosaveCache(json)
  return { saved: true, filePath: targetPath }
}

export async function saveProjectFile(project: Project): Promise<SaveFileResult> {
  const json = serializeProject(project)
  if (!currentFilePath) return saveProjectAsDialog(project)
  await atomicWriteText(currentFilePath, json)
  await syncAutosaveCache(json)
  return { saved: true, filePath: currentFilePath }
}

export async function exportProjectDialog(project: Project): Promise<boolean> {
  const json = serializeProject(project)
  const res = await dialog.showSaveDialog({
    title: 'Xuất file dự án DMX Gauze',
    defaultPath: 'dmx-gauze-export.json',
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePath) return false
  await atomicWriteText(res.filePath, json)
  return true
}
