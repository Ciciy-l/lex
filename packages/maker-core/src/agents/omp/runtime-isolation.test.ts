import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { OmpAgent, createOmpSessionRuntimeHome } from './index.js';
import { createOmpSessionLaunchPlan } from './launch-plan.js';
import type { AgentDeps } from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

function createScannerAgent(home: string): OmpAgent {
  const deps: AgentDeps = {
    auth: {
      getState: async () => ({ authenticated: false }),
      triggerLogin: async () => ({ authenticated: false }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: silentLogger,
    resolveOmpAgentHome: () => home,
  };
  return new OmpAgent(deps);
}

function planFor(home: string, workingDir: string) {
  return createOmpSessionLaunchPlan({
    roots: {
      home,
      workingDir,
      platform: process.platform,
      ...(process.platform === 'win32' && process.env.SystemRoot
        ? { windowsSystemRoot: process.env.SystemRoot }
        : {}),
    },
    permissionMode: 'ask',
    model: { provider: 'cindy', model: 'test-model' },
  });
}

describe('OMP session runtime isolation', () => {
  it('gives concurrently starting Lead and Worker processes distinct config and model files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-runtime-isolation-'));
    try {
      const leadHome = createOmpSessionRuntimeHome(root, 'lead-instance');
      const workerHome = createOmpSessionRuntimeHome(root, 'worker-instance');
      const workdir = path.join(root, 'workspace');
      const lead = planFor(leadHome, workdir);
      const worker = planFor(workerHome, workdir);

      expect(leadHome).not.toBe(workerHome);
      expect(path.relative(root, leadHome).startsWith('..')).toBe(false);
      expect(path.relative(root, workerHome).startsWith('..')).toBe(false);
      expect(lead.roots.settingsFile).not.toBe(worker.roots.settingsFile);
      expect(lead.roots.modelsFile).not.toBe(worker.roots.modelsFile);
      expect(lead.roots.sessions).not.toBe(worker.roots.sessions);
      expect(lead.environment.HOME).not.toBe(worker.environment.HOME);

      await Promise.all([
        mkdir(path.dirname(lead.roots.settingsFile), { recursive: true })
          .then(() => writeFile(lead.roots.settingsFile, 'lead-settings'))
          .then(() => writeFile(lead.roots.modelsFile, 'lead-models')),
        mkdir(path.dirname(worker.roots.settingsFile), { recursive: true })
          .then(() => writeFile(worker.roots.settingsFile, 'worker-settings'))
          .then(() => writeFile(worker.roots.modelsFile, 'worker-models')),
      ]);

      await expect(readFile(lead.roots.modelsFile, 'utf8')).resolves.toBe('lead-models');
      await expect(readFile(worker.roots.modelsFile, 'utf8')).resolves.toBe('worker-models');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not turn a scanned Skill into a guessed native command', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'omp-runtime-palette-'));
    try {
      const workspace = path.join(root, 'workspace');
      const skill = path.join(workspace, '.agents', 'skills', 'project-skill');
      await mkdir(path.join(workspace, '.git'), { recursive: true });
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, 'SKILL.md'), [
        '---',
        'name: shared-native-name',
        '---',
        '# Project Skill',
      ].join('\n'));

      const skills = await createScannerAgent(path.join(root, 'agent-home')).listAgentSkills({
        workingDir: workspace,
      });
      const projectSkill = skills.skills.find((item) => item.name === 'project-skill');

      expect(projectSkill).toMatchObject({
        kind: 'agent-skill',
        scope: 'repo',
        runtimeStatus: 'unknown',
      });
      expect(projectSkill?.runtimeCommandName).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
