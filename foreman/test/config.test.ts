import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { rmrf, tempDir } from './helpers.js';

let home: string | undefined;
afterEach(() => {
  if (home) rmrf(home);
  home = undefined;
});

function load(args: string[]) {
  home = tempDir();
  return loadConfig(['--home', home, ...args], {});
}

describe('loadConfig argument checking', () => {
  it('accepts the documented claude flags', () => {
    const cfg = load(['--backend', 'claude', '--workers', 'juniper,kit', '--model', 'sonnet', '--effort', 'low', '--no-notify', '--max-budget', '2']);
    expect(cfg.claude.workers).toEqual(['juniper', 'kit']);
    expect(cfg.claude.leadModel).toBe('sonnet');
    expect(cfg.claude.workerModel).toBe('sonnet');
    expect(cfg.claude.effort).toBe('low');
    expect(cfg.claude.leadEffort).toBe('low');
    expect(cfg.notify).toBe(false);
  });

  it('reads lead read commands as a comma list or a config.json array', () => {
    home = tempDir();
    const read = (args: string[], env = {}) => loadConfig(['--home', home!, ...args], env).claude.leadReadCommands;
    expect(read(['--lead-read-commands', 'bd show, bd list,'])).toEqual(['bd show', 'bd list']);
    expect(read([], { AGENTCRAFT_LEAD_READ_COMMANDS: 'bd show' })).toEqual(['bd show']);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { leadReadCommands: ['bd show'] } }));
    expect(read([])).toEqual(['bd show']);
  });

  it('rejects lead read commands that could write or run code', () => {
    home = tempDir();
    for (const bad of ['rm', 'git status', './bd show', 'bd show; rm x', 'bd show > f', 'bash', 'bd $(x)']) {
      expect(() => loadConfig(['--home', home!, '--lead-read-commands', bad], {})).toThrow(/lead read command/);
    }
  });

  it('accepts the documented antigravity flags and agy alias', () => {
    const cfg = load(['--backend', 'antigravity', '--agy-bin', '/usr/local/bin/agy', '--agy-model', 'gemini-3.8-flash-low', '--effort', 'low', '--workers', 'kit,lex']);
    expect(cfg.backend).toBe('antigravity');
    expect(cfg.antigravity.agyBin).toBe('/usr/local/bin/agy');
    expect(cfg.antigravity.leadModel).toBe('gemini-3.8-flash-low');
    expect(cfg.antigravity.workerModel).toBe('gemini-3.8-flash-low');
    expect(cfg.antigravity.effort).toBe('low');
    expect(cfg.antigravity.workers).toEqual(['kit', 'lex']);
    expect(cfg.notify).toBe(true);

    const cfgAgy = load(['--backend', 'agy']);
    expect(cfgAgy.backend).toBe('antigravity');
  });

  it('defaults to the opencode backend with medium preset models', () => {
    const cfg = load([]);
    expect(cfg.backend).toBe('opencode');
    expect(cfg.opencode.ocBin).toBe('opencode');
    expect(cfg.opencode.leadModel).toBe('opencode-go/muse-spark-1.3-contributor');
    expect(cfg.opencode.transientRetries).toBe(3);
    expect(cfg.notify).toBe(true);
  });

  it('accepts the documented opencode flags and oc alias', () => {
    const cfg = load(['--backend', 'opencode', '--opencode-bin', '/usr/local/bin/opencode', '--opencode-model', 'opencode/gpt-5.5', '--opencode-lead-agent', 'plan', '--effort', 'high', '--preset', 'light', '--workers', 'kit']);
    expect(cfg.opencode.ocBin).toBe('/usr/local/bin/opencode');
    expect(cfg.opencode.leadAgent).toBe('plan');
    expect(cfg.opencode.workers).toEqual(['kit']);
    // explicit flags win over the preset
    expect(cfg.opencode.leadModel).toBe('opencode/gpt-5.5');
    expect(cfg.opencode.effort).toBe('high');
    expect(cfg.opencode.preset).toBe('light');

    const cfgOc = load(['--backend', 'oc']);
    expect(cfgOc.backend).toBe('opencode');
  });

  it('applies presets below explicit flags', () => {
    const cfg = load(['--backend', 'antigravity', '--preset', 'heavy']);
    expect(cfg.antigravity.leadModel).toBe('gemini-3.8-flash-high');
    expect(cfg.antigravity.workerModel).toBe('gemini-3.8-flash-high');
    expect(cfg.antigravity.preset).toBe('heavy');

    const cfg2 = load(['--backend', 'antigravity', '--preset', 'heavy', '--worker-model', 'custom']);
    expect(cfg2.antigravity.workerModel).toBe('custom');
    expect(cfg2.antigravity.leadModel).toBe('gemini-3.8-flash-high');

    expect(() => load(['--preset', 'xl'])).toThrow(/unknown preset/);
  });

  it('accepts the sim flags launch.ps1 passes', () => {
    const cfg = load(['--backend', 'sim', '--profile', 'x', '--port', '41000', '--reset', '--showcase', 'late', '--speed', '2', '--autostart']);
    expect(cfg.sim.showcaseAt).toBe('showcase-late');
    expect(cfg.sim.speed).toBe(2);
  });

  // regression: PowerShell `-File launch.ps1 -ForemanArgs '--workers,juniper,kit,--model,sonnet'` hands
  // the Foreman ONE argument; it used to be ignored silently and the team started on opus/medium/3 workers
  it('refuses an argument that PowerShell joined with commas', () => {
    expect(() => load(['--backend', 'claude', '--workers,juniper,kit,--model,sonnet,--effort,low'])).toThrow(/unknown option "--workers,juniper,kit,--model,sonnet,--effort,low"/);
  });

  it('refuses mistyped flags and stray positionals', () => {
    expect(() => load(['--wokers', 'kit'])).toThrow(/unknown option "--wokers"/);
    expect(() => load(['--backend', 'sim', 'oops', 'extra'])).toThrow(/unexpected argument "oops"/);
  });

  it('refuses an unknown effort instead of falling back to medium', () => {
    expect(() => load(['--effort', 'lo'])).toThrow(/unknown effort "lo"/);
  });
});

describe('user name', () => {
  it('comes from --user-name, then AGENTCRAFT_USER_NAME, then config.json, else the OS account', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { defaultUserName } = await import('../src/user.js');
    expect(load(['--user-name', 'Sam']).userName).toBe('Sam');
    home = tempDir();
    expect(loadConfig(['--home', home], { AGENTCRAFT_USER_NAME: 'Robin' }).userName).toBe('Robin');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ userName: 'Kai' }));
    expect(loadConfig(['--home', home], {}).userName).toBe('Kai');
    rmrf(home);
    const d = load([]).userName;
    expect(d).toBe(defaultUserName());
    expect(d.length).toBeGreaterThan(0);
  });

  it('is sent to the mod in foreman.status and used in prompts', async () => {
    const { makeForeman } = await import('./helpers.js');
    const { leadSystemPrompt } = await import('../src/agents/claude/prompts.js');
    home = tempDir();
    const h = makeForeman(home, ['--user-name', 'Sam']);
    try {
      expect(h.fm.status.userName).toBe('Sam');
      expect(h.fm.nameOf('user')).toBe('Sam');
      expect(leadSystemPrompt(h.fm, ['kit'])).toContain('The user is Sam.');
    } finally {
      await h.fm.close();
    }
  });
});
