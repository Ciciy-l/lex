import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanCustomizationSources } from '../shared/customization-scanner.js';
import type { AgentCustomization } from '../../types/customizations.js';
import {
  buildOmpSources,
  ompDisabledSkillNames,
  ompRuntimeSkillName,
} from './customization-scanner.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-customizations-'));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, name: string, description = name): Promise<string> {
  const skill = path.join(root, name);
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(skill, 'SKILL.md'),
    ['---', 'description: ' + description, '---', '# ' + name, ''].join('\n'),
  );
  return skill;
}

function discoveredSkill(name: string, absolutePath: string, runtimeName?: string): AgentCustomization {
  return {
    engine: 'omp',
    kind: 'skill',
    scope: 'repo',
    name,
    absolutePath,
    ...(runtimeName === undefined ? {} : { frontmatter: { name: runtimeName } }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OMP customization scanner', () => {
  it('discovers shared and native project Skill roots only through the nearest Git boundary', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    const outer = path.join(root, 'outer');
    const repository = path.join(outer, 'repo');
    const workingDir = path.join(repository, 'packages', 'feature', 'src');
    await mkdir(path.join(repository, '.git'), { recursive: true });
    await mkdir(workingDir, { recursive: true });

    await writeSkill(path.join(home, '.agents', 'skills'), 'global-skill');
    await writeSkill(path.join(workingDir, '.omp', 'skills'), 'omp-local');
    await writeSkill(path.join(repository, 'packages', 'feature', '.agents', 'skills'), 'agents-parent');
    await writeSkill(path.join(repository, '.claude', 'skills'), 'claude-root');
    await writeSkill(path.join(repository, '.codex', 'skills'), 'codex-root');
    await writeSkill(path.join(repository, '.github', 'skills'), 'github-root');
    await writeSkill(path.join(outer, '.agents', 'skills'), 'outside-repository');

    const sources = buildOmpSources([workingDir], home);
    const result = scanCustomizationSources(sources, null);
    const names = result.items.map((item) => item.name).sort();

    expect(names).toEqual([
      'agents-parent',
      'claude-root',
      'codex-root',
      'github-root',
      'global-skill',
      'omp-local',
    ]);
    expect(names).not.toContain('outside-repository');
    expect(result.errors).toEqual([]);
    expect(result.items.every((item) => item.engine === 'omp')).toBe(true);
    expect(result.items.filter((item) => item.scope === 'repo').every(
      (item) => item.workingDir === path.resolve(workingDir) && item.runtimeStatus === 'discovered',
    )).toBe(true);
  });

  it('only disables a native runtime name when every discovered source with that name is disabled', () => {
    const root = path.join(path.sep, 'synthetic-omp-skills');
    const primary = path.join(root, 'primary');
    const fallback = path.join(root, 'fallback');
    const other = path.join(root, 'other');
    const items = [
      discoveredSkill('primary', primary, 'shared-name'),
      discoveredSkill('fallback', fallback, 'shared-name'),
      discoveredSkill('other', other),
    ];

    expect(ompDisabledSkillNames(items, [primary])).toEqual([]);
    expect(ompDisabledSkillNames(items, [primary, fallback, other])).toEqual(['other', 'shared-name']);
  });

  it('uses a valid frontmatter name for the native command identity and rejects control characters', () => {
    const source = discoveredSkill('folder-name', path.join(path.sep, 'tmp', 'skill'), 'native-name');
    expect(ompRuntimeSkillName(source)).toBe('native-name');
    expect(ompRuntimeSkillName(discoveredSkill(
      'folder-name',
      path.join(path.sep, 'tmp', 'bad-skill'),
      'bad' + String.fromCharCode(10) + 'name',
    ))).toBeUndefined();
  });
});
