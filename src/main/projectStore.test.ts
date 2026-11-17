import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '@shared/preset';
import type { Project } from '@shared/types';

const electronState = vi.hoisted(() => ({
  userDataDir: '',
  openDialogResult: { canceled: true, filePaths: [] as string[] },
  saveDialogResult: { canceled: true, filePath: undefined as string | undefined },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => electronState.openDialogResult),
    showSaveDialog: vi.fn(async () => electronState.saveDialogResult),
  },
}));

import {
  clearCurrentFilePath,
  exportProjectDialog,
  loadSavedProject,
  openProjectDialog,
  parseProjectJson,
  saveProjectAsDialog,
  saveProjectFile,
  saveProjectToDisk,
} from './projectStore';

describe('projectStore persistence & malformed import protection (Bug 2)', () => {
  const createdDirs: string[] = [];

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmx-gauze-store-'));
    createdDirs.push(dir);
    electronState.userDataDir = dir;
    electronState.openDialogResult = { canceled: true, filePaths: [] };
    electronState.saveDialogResult = { canceled: true, filePath: undefined };
    clearCurrentFilePath();
  });

  afterAll(async () => {
    await Promise.all(createdDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('rejects incomplete project JSON missing settings or invalid nested config', () => {
    expect(() => parseProjectJson('{"version":1,"layers":[],"modules":[]}')).toThrow();

    const invalidPortProject = createDefaultProject();
    invalidPortProject.settings.output.port = 70000;
    expect(() => parseProjectJson(JSON.stringify(invalidPortProject))).toThrow();

    const invalidLtcProject = createDefaultProject();
    invalidLtcProject.settings.ltc.freewheelFrames = -5;
    expect(() => parseProjectJson(JSON.stringify(invalidLtcProject))).toThrow();
  });

  it('protects existing autosave on disk when opening malformed import files', async () => {
    const valid = createDefaultProject();
    valid.modules[0].name = 'Protected Module Name';
    await saveProjectToDisk(valid);

    const autosavePath = path.join(electronState.userDataDir, 'project.json');
    const beforeAutosave = await fs.readFile(autosavePath, 'utf8');

    const badFile = path.join(electronState.userDataDir, 'bad-import.json');
    await fs.writeFile(badFile, '{"version":1,"layers":[],"modules":[]}', 'utf8');
    electronState.openDialogResult = { canceled: false, filePaths: [badFile] };

    await expect(openProjectDialog()).rejects.toThrow();

    const afterAutosave = await fs.readFile(autosavePath, 'utf8');
    expect(afterAutosave).toBe(beforeAutosave);

    const badRangeProject = createDefaultProject();
    (badRangeProject.settings as { lockValue: number }).lockValue = 999;
    const badRangeFile = path.join(electronState.userDataDir, 'bad-range.json');
    await fs.writeFile(badRangeFile, JSON.stringify(badRangeProject), 'utf8');
    electronState.openDialogResult = { canceled: false, filePaths: [badRangeFile] };

    await expect(openProjectDialog()).rejects.toThrow();
    expect(await fs.readFile(autosavePath, 'utf8')).toBe(beforeAutosave);
  });

  it('recovers gracefully to valid default project when persisted autosave is damaged', async () => {
    const autosavePath = path.join(electronState.userDataDir, 'project.json');

    await fs.writeFile(autosavePath, '{not-valid-json', 'utf8');
    const fromCorruptJson = await loadSavedProject();
    expect(fromCorruptJson.project.version).toBe(1);
    expect(fromCorruptJson.project.settings.output.driver).toBeTruthy();
    expect(fromCorruptJson.project.modules.length).toBeGreaterThan(0);

    await fs.writeFile(autosavePath, '{"version":1,"layers":[],"modules":[]}', 'utf8');
    const fromIncompleteSchema = await loadSavedProject();
    expect(fromIncompleteSchema.project.version).toBe(1);
    expect(fromIncompleteSchema.project.settings.output.driver).toBeTruthy();
    expect(fromIncompleteSchema.project.settings.timeline.fps).toBe(25);
    expect(fromIncompleteSchema.project.modules.length).toBeGreaterThan(0);
  });

  it('round-trips valid saved project through saveProjectToDisk and loadSavedProject', async () => {
    const valid = createDefaultProject();
    valid.modules[0].name = 'Persisted Scene';
    await saveProjectToDisk(valid);

    const loaded = await loadSavedProject();
    expect(loaded.project.modules[0].name).toBe('Persisted Scene');
    expect(loaded.project.settings).toEqual(valid.settings);
  });

  it('preserves previous currentFilePath when Save As fails and saves subsequent Save to old path', async () => {
    const valid = createDefaultProject();
    valid.modules[0].name = 'Old Saved Scene';
    const oldPath = path.join(electronState.userDataDir, 'old.json');
    electronState.saveDialogResult = { canceled: false, filePath: oldPath };

    const resOld = await saveProjectAsDialog(valid);
    expect(resOld).toEqual({ saved: true, filePath: oldPath });
    expect(await fs.readFile(oldPath, 'utf8')).toContain('Old Saved Scene');

    // Make Save As destination fail deterministically (regular file acting as parent directory).
    const blockerFile = path.join(electronState.userDataDir, 'blocker');
    await fs.writeFile(blockerFile, 'not-a-directory', 'utf8');
    const badPath = path.join(blockerFile, 'bad.json');

    const editedBeforeFail = createDefaultProject();
    editedBeforeFail.modules[0].name = 'Failed SaveAs Attempt';
    electronState.saveDialogResult = { canceled: false, filePath: badPath };
    await expect(saveProjectAsDialog(editedBeforeFail)).rejects.toThrow();

    // Old file and autosave must still hold the previous valid state, not the failed Save As payload.
    expect(await fs.readFile(oldPath, 'utf8')).toContain('Old Saved Scene');
    const autosavePath = path.join(electronState.userDataDir, 'project.json');
    expect(await fs.readFile(autosavePath, 'utf8')).toContain('Old Saved Scene');

    // Subsequent Save (without Save As) must still target old.json, NOT bad.json!
    const nextEdit = createDefaultProject();
    nextEdit.modules[0].name = 'Updated Old Scene';
    const resFollowUpSave = await saveProjectFile(nextEdit);
    expect(resFollowUpSave).toEqual({ saved: true, filePath: oldPath });
    expect(await fs.readFile(oldPath, 'utf8')).toContain('Updated Old Scene');
  });

  it('validates explicit saveAs, saveFile, and exportProject calls before mutating files or paths', async () => {
    const valid = createDefaultProject();
    valid.modules[0].name = 'Valid Baseline';
    const oldPath = path.join(electronState.userDataDir, 'baseline.json');
    electronState.saveDialogResult = { canceled: false, filePath: oldPath };
    await saveProjectAsDialog(valid);
    const oldBefore = await fs.readFile(oldPath, 'utf8');

    const invalidIncomplete = { version: 1, layers: [], modules: [] } as unknown as Project;
    const exportTarget = path.join(electronState.userDataDir, 'exported.json');
    const saveAsTarget = path.join(electronState.userDataDir, 'should-not-exist.json');

    electronState.saveDialogResult = { canceled: false, filePath: saveAsTarget };
    await expect(saveProjectAsDialog(invalidIncomplete)).rejects.toThrow();
    await expect(fs.stat(saveAsTarget)).rejects.toThrow();

    await expect(saveProjectFile(invalidIncomplete)).rejects.toThrow();
    expect(await fs.readFile(oldPath, 'utf8')).toBe(oldBefore);

    electronState.saveDialogResult = { canceled: false, filePath: exportTarget };
    await expect(exportProjectDialog(invalidIncomplete)).rejects.toThrow();
    await expect(fs.stat(exportTarget)).rejects.toThrow();

    // Valid export writes cleanly with zero lingering temp files.
    expect(await exportProjectDialog(valid)).toBe(true);
    expect(await fs.readFile(exportTarget, 'utf8')).toContain('Valid Baseline');
    const entries = await fs.readdir(electronState.userDataDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('keeps Save As outcome and currentFilePath consistent when explicit target succeeds but cache rename fails', async () => {
    const filesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmx-gauze-files-'));
    createdDirs.push(filesDir);

    const oldProject = createDefaultProject();
    oldProject.modules[0].name = 'Old Scene';
    const oldPath = path.join(filesDir, 'old.json');
    electronState.saveDialogResult = { canceled: false, filePath: oldPath };
    expect(await saveProjectAsDialog(oldProject)).toEqual({ saved: true, filePath: oldPath });

    // Cause cache autosave rename(tmp -> userData/project.json) to fail while explicit Save As target succeeds.
    const cacheFile = path.join(electronState.userDataDir, 'project.json');
    await fs.rm(cacheFile, { force: true });
    await fs.mkdir(cacheFile);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const newProject = createDefaultProject();
      newProject.modules[0].name = 'Saved New Scene';
      const newPath = path.join(filesDir, 'new.json');
      electronState.saveDialogResult = { canceled: false, filePath: newPath };

      const saveAsRes = await saveProjectAsDialog(newProject);
      expect(saveAsRes).toEqual({ saved: true, filePath: newPath });
      expect(await fs.readFile(newPath, 'utf8')).toContain('Saved New Scene');

      // Subsequent Save matches both main currentFilePath and renderer saved result (writes to newPath).
      const followUp = createDefaultProject();
      followUp.modules[0].name = 'FollowUp Same New Path';
      const followUpRes = await saveProjectFile(followUp);
      expect(followUpRes).toEqual({ saved: true, filePath: newPath });
      expect(await fs.readFile(newPath, 'utf8')).toContain('FollowUp Same New Path');
      expect(await fs.readFile(oldPath, 'utf8')).toContain('Old Scene');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('migrates legacy saved project with Art-Net + port 5568 to 6454 and persists 40/50/60 fps', async () => {
    const legacy = createDefaultProject();
    legacy.settings.output.driver = 'artnet';
    legacy.settings.output.port = 5568;
    legacy.settings.timeline.fps = 25;

    const autosavePath = path.join(electronState.userDataDir, 'project.json');
    await fs.writeFile(autosavePath, JSON.stringify(legacy, null, 2), 'utf8');

    const loadedLegacy = await loadSavedProject();
    expect(loadedLegacy.project.settings.output.driver).toBe('artnet');
    expect(loadedLegacy.project.settings.output.port).toBe(6454);
    expect(loadedLegacy.project.settings.timeline.fps).toBe(25);
    expect(JSON.parse(await fs.readFile(autosavePath, 'utf8')).settings.output.port).toBe(6454);

    const hiFps = createDefaultProject();
    hiFps.settings.timeline.fps = 60;
    hiFps.settings.ltc.fps = 25;
    await saveProjectToDisk(hiFps);
    const loadedHi = await loadSavedProject();
    expect(loadedHi.project.settings.timeline.fps).toBe(60);
    expect(loadedHi.project.settings.ltc.fps).toBe(25);
  });
});
