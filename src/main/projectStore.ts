import { app, dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectFileResult, SaveFileResult } from '@shared/api'
import { createDefaultProject, normalizeProject } from '@shared/preset'
import type { Project } from '@shared/types'

let currentFilePath: string | null = null

function defaultFilePath(): string {
  return join(app.getPath('userData'), 'project.json')
}

function parseProjectJson(raw: string): Project {
  const parsed = JSON.parse(raw) as Project
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.modules) || !Array.isArray(parsed.layers)) {
    throw new Error('File dự án không hợp lệ')
  }
  return normalizeProject(parsed)
}

export async function loadSavedProject(): Promise<ProjectFileResult> {
  try {
    const raw = await readFile(defaultFilePath(), 'utf8')
    return { project: parseProjectJson(raw), filePath: currentFilePath }
  } catch {
    /* lần đầu chưa có file */
  }
  return { project: createDefaultProject(), filePath: null }
}

export async function saveProjectToDisk(project: Project): Promise<void> {
  await writeFile(defaultFilePath(), JSON.stringify(project, null, 2), 'utf8')
}

export function clearCurrentFilePath(): void {
  currentFilePath = null
}

export async function openProjectDialog(): Promise<ProjectFileResult | null> {
  const res = await dialog.showOpenDialog({
    title: 'Mở dự án DMX Gauze',
    properties: ['openFile'],
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePaths[0]) return null
  const filePath = res.filePaths[0]
  const raw = await readFile(filePath, 'utf8')
  const project = parseProjectJson(raw)
  currentFilePath = filePath
  await saveProjectToDisk(project)
  return { project, filePath }
}

export async function saveProjectAsDialog(project: Project): Promise<SaveFileResult> {
  const res = await dialog.showSaveDialog({
    title: 'Lưu dự án DMX Gauze thành...',
    defaultPath: currentFilePath ?? 'dmx-gauze-project.json',
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePath) return { saved: false, filePath: currentFilePath }
  currentFilePath = res.filePath
  const json = JSON.stringify(project, null, 2)
  await writeFile(res.filePath, json, 'utf8')
  await writeFile(defaultFilePath(), json, 'utf8')
  return { saved: true, filePath: currentFilePath }
}

export async function saveProjectFile(project: Project): Promise<SaveFileResult> {
  if (!currentFilePath) return saveProjectAsDialog(project)
  const json = JSON.stringify(project, null, 2)
  await writeFile(currentFilePath, json, 'utf8')
  await writeFile(defaultFilePath(), json, 'utf8')
  return { saved: true, filePath: currentFilePath }
}

export async function exportProjectDialog(project: Project): Promise<boolean> {
  const res = await dialog.showSaveDialog({
    title: 'Xuất file dự án DMX Gauze',
    defaultPath: 'dmx-gauze-export.json',
    filters: [{ name: 'DMX Gauze Project', extensions: ['json'] }],
  })
  if (res.canceled || !res.filePath) return false
  await writeFile(res.filePath, JSON.stringify(project, null, 2), 'utf8')
  return true
}
