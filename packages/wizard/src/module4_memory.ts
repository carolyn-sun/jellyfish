/**
 * Module 4 — Memory Shaping
 * Configures which users' interactions qualify for long-term memory absorption
 * and whether to enable nightly personality evolution.
 */
import * as p from '@clack/prompts';
import pc from 'picocolors';

export interface MemoryConfig {
  memoryWhitelist: string[] | 'all';
  enableNightlyEvolution: boolean;
}

export async function collectMemoryConfig(): Promise<MemoryConfig> {
  p.log.message('');
  p.log.message(pc.bold('🧠 Memory Shaping (Nightly Evolution)'));
  p.log.message(pc.dim('Interactions from "memory whitelist" users are absorbed into the agent\'s'));
  p.log.message(pc.dim('long-term memory and used to evolve the persona.skill at night.'));

  const whitelistMode = await p.select({
    message: 'Who can shape long-term memory?',
    options: [
      { value: 'specific', label: '🎯 Specific users only (recommended)' },
      { value: 'all', label: '🌍 Everyone (all interactions absorbed)' },
    ],
  }) as 'specific' | 'all';

  if (p.isCancel(whitelistMode)) process.exit(0);

  let memoryWhitelist: string[] | 'all' = 'all';

  if (whitelistMode === 'specific') {
    const users: string[] = [];
    let addMore = true;
    let count = 0;

    p.log.message(pc.dim('Tip: Add the VIP users whose conversations should shape the persona.'));

    while (addMore) {
      const username = await p.text({
        message: count === 0
          ? 'Enter @username to add to memory whitelist (or leave blank to skip):'
          : 'Add another? Enter @username (or leave blank to finish):',
        placeholder: 'e.g. amber_medusozoa',
      }) as string;

      if (p.isCancel(username) || !username?.trim()) {
        addMore = false;
        break;
      }

      const clean = username.trim().replace(/^@/, '');
      if (!users.includes(clean)) {
        users.push(clean);
        count++;
        p.log.success(`Added @${clean} to memory whitelist`);
      } else {
        p.log.warn(`@${clean} already in whitelist`);
      }
    }

    if (users.length === 0) {
      p.log.warn('No users added — memory whitelist will be empty (effectively disabling memory absorption).');
      memoryWhitelist = [];
    } else {
      memoryWhitelist = users;
    }
  }

  // Nightly evolution toggle
  p.log.message('');
  const enableNightlyEvolution = await p.confirm({
    message: 'Enable nightly personality evolution? (LLM rewrites persona.skill from absorbed memories at 3 AM)',
    initialValue: true,
  }) as boolean;

  if (p.isCancel(enableNightlyEvolution)) process.exit(0);

  p.log.message('');
  if (memoryWhitelist === 'all') {
    p.log.success(pc.green('Memory: all users can shape the persona'));
  } else if (memoryWhitelist.length > 0) {
    p.log.success(pc.green(`Memory whitelist: ${memoryWhitelist.map(u => '@' + u).join(', ')}`));
  } else {
    p.log.warn('Memory whitelist is empty — no interactions will be absorbed');
  }

  if (enableNightlyEvolution) {
    p.log.success(pc.green('Nightly evolution enabled (runs at 3:00 AM)'));
  } else {
    p.log.message(pc.dim('Nightly evolution disabled'));
  }

  return { memoryWhitelist, enableNightlyEvolution };
}
