import { app, dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDefaultProject } from '@shared/preset'
import type { Project } from '@shared/types'

function defaultFilePath(): string {
  return join(app.getPath('userData'), 'project.json')
}

export async function loadSavedProject(): Promise<Project> {
  try {
    const raw = await readFile(defaultFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as Project
    if (parsed && parsed.version === 1 && Array.isArray(parsed.modules)) return parsed
  } catch {
    /* lần đầu chưa có file */
  }
  return createDefaultProject()
}

export async function saveProjectToDisk(project: Project): Promise<void> {
  await writeFile(defaultFilePath(), JSON.stringify(project, null, 2), 'utf8')
}

export async function exportProjectDialog(project: Project): Promise<boolean> {
  const res = await dialog.showSaveDialog({
    title: 'Xuất dự án DMX Gauze',
    defaultPath: 'dmx-gauze-project.json',
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePath) return false
  await writeFile(res.filePath, JSON.stringify(project, null, 2), 'utf8')
  return true
}

export async function importProjectDialog(): Promise<Project | null> {
  const res = await dialog.showOpenDialog({
    title: 'Nhập dự án DMX Gauze',
    properties: ['openFile'],
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePaths[0]) return null
  const raw = await readFile(res.filePaths[0], 'utf8')
  const parsed = JSON.parse(raw) as Project
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.modules)) {
    throw new Error('File dự án không hợp lệ')
  }
  await saveProjectToDisk(parsed)
  return parsed
}
