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

  it('preserves home offset (mm) per module alongside legacy modules without calibration', async () => {
    const project = createDefaultProject();
    project.modules[0].homeOffsetMm = 0;
    project.modules[1].homeOffsetMm = 40;
    await saveProjectToDisk(project);

    const { project: loaded } = await loadSavedProject();
    expect(loaded.schemaVersion).toBe(project.schemaVersion);
    expect(loaded.modules.slice(0, 3).map((module) => module.homeOffsetMm)).toEqual([0, 40, undefined]);
  });

  it.each([-1, 40.5, 255])('rejects invalid home offset in project JSON (%i)', (mm) => {
    const project = createDefaultProject();
    project.modules[0].homeOffsetMm = mm;
    expect(() => parseProjectJson(JSON.stringify(project))).toThrow(/homeOffsetMm/);
  });

  it('preserves previous currentFilePath when Save As fails and saves subsequent Save to old path', async () => {
    const valid = createDefaultProject();
    valid.modules[0].name = 'Old Saved Scene';
    const oldPath = path.join(electronState.userDataDir, 'old.mikdmx');
    electronState.saveDialogResult = { canceled: false, filePath: oldPath };

    const resOld = await saveProjectAsDialog(valid);
    expect(resOld).toEqual({ saved: true, filePath: oldPath });
    expect(await fs.readFile(oldPath, 'utf8')).toContain('Old Saved Scene');

    // Make Save As destination fail deterministically (regular file acting as parent directory).
    const blockerFile = path.join(electronState.userDataDir, 'blocker');
    await fs.writeFile(blockerFile, 'not-a-directory', 'utf8');
    const badPath = path.join(blockerFile, 'bad.mikdmx');

    const editedBeforeFail = createDefaultProject();
    editedBeforeFail.modules[0].name = 'Failed SaveAs Attempt';
    electronState.saveDialogResult = { canceled: false, filePath: badPath };
    await expect(saveProjectAsDialog(editedBeforeFail)).rejects.toThrow();

    // Old file and autosave must still hold the previous valid state, not the failed Save As payload.
    expect(await fs.readFile(oldPath, 'utf8')).toContain('Old Saved Scene');
    const autosavePath = path.join(electronState.userDataDir, 'project.json');
    expect(await fs.readFile(autosavePath, 'utf8')).toContain('Old Saved Scene');

    // Subsequent Save (without Save As) must still target old.mikdmx, NOT bad.mikdmx!
    const nextEdit = createDefaultProject();
    nextEdit.modules[0].name = 'Updated Old Scene';
    const resFollowUpSave = await saveProjectFile(nextEdit);
    expect(resFollowUpSave).toEqual({ saved: true, filePath: oldPath });
    expect(await fs.readFile(oldPath, 'utf8')).toContain('Updated Old Scene');
  });

  it('validates explicit saveAs, saveFile, and exportProject calls before mutating files or paths', async () => {
    const valid = createDefaultProject();
    valid.modules[0].name = 'Valid Baseline';
    const oldPath = path.join(electronState.userDataDir, 'baseline.mikdmx');
    electronState.saveDialogResult = { canceled: false, filePath: oldPath };
    await saveProjectAsDialog(valid);
    const oldBefore = await fs.readFile(oldPath, 'utf8');

    const invalidIncomplete = { version: 1, layers: [], modules: [] } as unknown as Project;
    const exportTarget = path.join(electronState.userDataDir, 'exported.mikdmx');
    const saveAsTarget = path.join(electronState.userDataDir, 'should-not-exist.mikdmx');

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
    const oldPath = path.join(filesDir, 'old.mikdmx');
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
      const newPath = path.join(filesDir, 'new.mikdmx');
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

  it.each([25, 30, 40, 50, 60, 45])('persists a configured DMX rate of %i Hz', async (sendHz) => {
    const project = createDefaultProject();
    project.settings.output.sendHz = sendHz;
    await saveProjectToDisk(project);
    const { project: loaded } = await loadSavedProject();
    expect(loaded.settings.output.sendHz).toBe(sendHz === 45 ? 25 : sendHz);
    expect(loaded.settings.timeline.fps).toBe(project.settings.timeline.fps);
  });

  it('migrates legacy v1.0.0 sACN/KiNET 6454 -> 5568/6038 while preserving custom ports across v1.0.0 and schemaVersion 2', async () => {
    const autosavePath = path.join(electronState.userDataDir, 'project.json');

    // 1) Legacy v1.0.0 sACN project (no schemaVersion) with stored port 6454 -> migrates to effective v1.0.0 port 5568.
    const legacySacn = createDefaultProject();
    delete legacySacn.schemaVersion;
    legacySacn.settings.output.driver = 'sacn';
    legacySacn.settings.output.port = 6454;
    await fs.writeFile(autosavePath, JSON.stringify(legacySacn, null, 2), 'utf8');
    const loadedSacnLegacy = await loadSavedProject();
    expect(loadedSacnLegacy.project.settings.output.port).toBe(5568);
    expect(loadedSacnLegacy.project.schemaVersion).toBe(2);
    expect(JSON.parse(await fs.readFile(autosavePath, 'utf8')).settings.output.port).toBe(5568);

    // 2) Legacy v1.0.0 KiNET project (no schemaVersion) with stored port 6454 -> migrates to effective v1.0.0 port 6038.
    const legacyKinet = createDefaultProject();
    delete legacyKinet.schemaVersion;
    legacyKinet.settings.output.driver = 'kinet';
    legacyKinet.settings.output.port = 6454;
    await fs.writeFile(autosavePath, JSON.stringify(legacyKinet, null, 2), 'utf8');
    const loadedKinetLegacy = await loadSavedProject();
    expect(loadedKinetLegacy.project.settings.output.port).toBe(6038);
    expect(loadedKinetLegacy.project.schemaVersion).toBe(2);

    // 3) Legacy v1.0.0 broadcast Art-Net deliberately on 5568 (no schemaVersion) -> preserved unchanged.
    const broadcast5568 = createDefaultProject();
    delete broadcast5568.schemaVersion;
    broadcast5568.settings.output.driver = 'artnet';
    broadcast5568.settings.output.port = 5568;
    broadcast5568.settings.timeline.fps = 25;
    await fs.writeFile(autosavePath, JSON.stringify(broadcast5568, null, 2), 'utf8');

    const loaded5568 = await loadSavedProject();
    expect(loaded5568.project.settings.output.driver).toBe('artnet');
    expect(loaded5568.project.settings.output.port).toBe(5568);
    expect(loaded5568.project.settings.timeline.fps).toBe(25);
    expect(JSON.parse(await fs.readFile(autosavePath, 'utf8')).settings.output.port).toBe(5568);

    // 4) Explicit v1.0.1 (schemaVersion: 2) custom port 6454 on sACN and KiNET -> preserved across save/reload!
    const explicitSacn6454 = createDefaultProject();
    explicitSacn6454.settings.output.driver = 'sacn';
    explicitSacn6454.settings.output.port = 6454;
    await saveProjectToDisk(explicitSacn6454);
    const loadedExplicitSacn = await loadSavedProject();
    expect(loadedExplicitSacn.project.settings.output.port).toBe(6454);

    // Saved project missing output.port falls back to protocol default (6454 for Art-Net).
    const missingPort = createDefaultProject();
    missingPort.settings.output.driver = 'artnet';
    delete (missingPort.settings.output as { port?: number }).port;
    await fs.writeFile(autosavePath, JSON.stringify(missingPort, null, 2), 'utf8');
    const loadedDefault = await loadSavedProject();
    expect(loadedDefault.project.settings.output.port).toBe(6454);

    const hiFps = createDefaultProject();
    hiFps.settings.timeline.fps = 60;
    hiFps.settings.ltc.fps = 25;
    await saveProjectToDisk(hiFps);
    const loadedHi = await loadSavedProject();
    expect(loadedHi.project.settings.timeline.fps).toBe(60);
    expect(loadedHi.project.settings.ltc.fps).toBe(25);

    // Existing saved project with custom receiver IP + Art-Net port 6038 is also preserved.
    const savedCustomReceiver = createDefaultProject();
    savedCustomReceiver.settings.output.driver = 'artnet';
    savedCustomReceiver.settings.output.ip = '192.168.1.50';
    savedCustomReceiver.settings.output.port = 6038;
    await fs.writeFile(autosavePath, JSON.stringify(savedCustomReceiver, null, 2), 'utf8');
    const loadedCustomReceiver = await loadSavedProject();
    expect(loadedCustomReceiver.project.settings.output.port).toBe(6038);
  });

  it('Save As appends .mikdmx without doubling, converts legacy .json, and offers the .mikdmx filter', async () => {
    const project = createDefaultProject();
    const { dialog } = await import('electron');
    const dir = electronState.userDataDir;
    for (const [typed, expected] of [
      ['plain', 'plain.mikdmx'],
      ['a.mikdmx', 'a.mikdmx'],
      ['B.MIKDMX', 'B.mikdmx'],
      ['legacy.json', 'legacy.mikdmx'],
    ]) {
      electronState.saveDialogResult = { canceled: false, filePath: path.join(dir, typed) };
      const res = await saveProjectAsDialog(project);
      expect(res).toEqual({ saved: true, filePath: path.join(dir, expected) });
      expect(JSON.parse(await fs.readFile(path.join(dir, expected), 'utf8')).version).toBe(1);
    }
    const opts = vi.mocked(dialog.showSaveDialog).mock.calls[0][0] as { filters: { extensions: string[] }[]; defaultPath: string };
    expect(opts.filters[0].extensions).toEqual(['mikdmx']);
    expect(opts.defaultPath.endsWith('.mikdmx')).toBe(true);
  });

  it('opens both .mikdmx and legacy .json; Save on a legacy .json never overwrites it', async () => {
    const dir = electronState.userDataDir;
    const project = createDefaultProject();
    project.modules[0].name = 'Legacy Scene';
    const legacy = path.join(dir, 'legacy-open.json');
    const modern = path.join(dir, 'modern-open.mikdmx');
    await fs.writeFile(legacy, JSON.stringify(project), 'utf8');
    await fs.writeFile(modern, JSON.stringify(project), 'utf8');

    electronState.openDialogResult = { canceled: false, filePaths: [modern] };
    expect((await openProjectDialog())?.project.modules[0].name).toBe('Legacy Scene');

    electronState.openDialogResult = { canceled: false, filePaths: [legacy] };
    const opened = await openProjectDialog();
    expect(opened?.filePath).toBe(legacy);
    const { dialog } = await import('electron');
    const openOpts = vi.mocked(dialog.showOpenDialog).mock.calls.at(-1)![0] as { filters: { extensions: string[] }[] };
    expect(openOpts.filters.map((f) => f.extensions)).toEqual([['mikdmx'], ['json']]);

    const before = await fs.readFile(legacy, 'utf8');
    electronState.saveDialogResult = { canceled: false, filePath: path.join(dir, 'legacy-open') };
    const res = await saveProjectFile(createDefaultProject());
    expect(res).toEqual({ saved: true, filePath: path.join(dir, 'legacy-open.mikdmx') });
    expect(await fs.readFile(legacy, 'utf8')).toBe(before);
  });

  it('Export appends .mikdmx too', async () => {
    const target = path.join(electronState.userDataDir, 'exp');
    electronState.saveDialogResult = { canceled: false, filePath: target };
    expect(await exportProjectDialog(createDefaultProject())).toBe(true);
    await expect(fs.stat(`${target}.mikdmx`)).resolves.toBeTruthy();
  });
});
