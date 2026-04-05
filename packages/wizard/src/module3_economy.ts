/**
 * Module 3 — Economy & Probability System
 * Collects behavioral configuration: default reply/like probabilities,
 * VIP user list with per-user overrides, spontaneous tweet schedule.
 */
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { VipEntry, CronSchedules } from './types.js';

export interface EconomyConfig {
  defaultReplyProbability: number;
  defaultLikeProbability: number;
  vipList: VipEntry[];
  spontaneousCooldownDays: number;
  cronSchedules: CronSchedules;
}

function pct(value: string | symbol): number {
  if (typeof value !== 'string') return 0;
  return Math.max(0, Math.min(100, Number(value))) / 100;
}

function validatePct(v: string | undefined): string | undefined {
  if (v == null) return 'Enter a number between 0 and 100';
  const n = Number(v);
  if (isNaN(n) || n < 0 || n > 100) return 'Enter a number between 0 and 100';
  return undefined;
}

function validatePositiveInt(v: string | undefined): string | undefined {
  if (v == null) return 'Enter a positive whole number';
  const n = Number(v);
  if (isNaN(n) || n < 1 || !Number.isInteger(n)) return 'Enter a positive whole number';
  return undefined;
}

function hoursToTimelineEngagementCron(hours: number): string {
  // e.g. 1h → "0 * * * *", 2h → "0 */2 * * *", 6h → "0 */6 * * *"
  if (hours === 1) return '0 * * * *';
  return `0 */${hours} * * *`;
}

// ─── VIP collection loop ───────────────────────────────────────────────────────
async function collectVipList(): Promise<VipEntry[]> {
  const vipList: VipEntry[] = [];

  p.log.message('');
  p.log.message(pc.bold('👑 VIP List Setup'));
  p.log.message(pc.dim('VIPs get special treatment — higher reply rates and custom persona modes.'));
  p.log.message(pc.dim('Example modes: "主人宠溺模式", "同行锐评模式", "开发者模式"'));

  let addMore = true;
  let count = 0;

  while (addMore) {
    const username = await p.text({
      message: count === 0
        ? 'Add a VIP user? Enter their @username (or leave blank to skip):'
        : `Add another VIP? Enter @username (or leave blank to finish):`,
      placeholder: 'e.g. amber_medusozoa',
    }) as string;

    if (p.isCancel(username) || !username?.trim()) {
      addMore = false;
      break;
    }

    const cleanUsername = username.trim().replace(/^@/, '');

    const replyPct = await p.text({
      message: `Reply probability for @${cleanUsername} (0-100%):`,
      placeholder: '95',
      defaultValue: '95',
      validate: validatePct,
    }) as string;
    if (p.isCancel(replyPct)) break;

    const likePctStr = await p.text({
      message: `Like probability for @${cleanUsername} on timeline (0-100%):`,
      placeholder: '100',
      defaultValue: '100',
      validate: validatePct,
    }) as string;
    if (p.isCancel(likePctStr)) break;

    const persona = await p.text({
      message: `Persona mode label for @${cleanUsername} (optional):`,
      placeholder: 'e.g. 主人宠溺模式 (leave blank for generic VIP)',
    }) as string;
    if (p.isCancel(persona)) break;

    const useCustomInstruction = await p.confirm({
      message: `Add a custom LLM override instruction for @${cleanUsername}?`,
      initialValue: false,
    });
    if (p.isCancel(useCustomInstruction)) break;

    let personaInstruction: string | undefined;
    if (useCustomInstruction) {
      const instruction = await p.text({
        message: `Enter the full LLM system-prompt override instruction for @${cleanUsername}:`,
        placeholder: '当前互动对象是你的正主...请给予宠溺回应',
        validate: (v: string | undefined) => v == null || v.trim().length === 0 ? 'Cannot be empty' : undefined,

      }) as string;
      if (p.isCancel(instruction)) break;
      personaInstruction = instruction.trim();
    }

    const entry: VipEntry = {
      username: cleanUsername,
      replyProbability: pct(replyPct),
      likeProbability: pct(likePctStr),
      ...(persona?.trim() && { persona: persona.trim() }),
      ...(personaInstruction && { personaInstruction }),
    };

    vipList.push(entry);
    count++;
    p.log.success(`Added VIP: @${cleanUsername} (reply: ${Math.round(entry.replyProbability * 100)}%${entry.persona ? ` | ${entry.persona}` : ''})`);
  }

  return vipList;
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function collectEconomy(): Promise<EconomyConfig> {
  p.log.message('');
  p.log.message(pc.bold('⚡ Default Interaction Probabilities'));
  p.log.message(pc.dim('These apply to all users NOT in your VIP list.'));

  const defaultReplyPctStr = await p.text({
    message: 'Default reply probability for strangers (0-100%):',
    placeholder: '20',
    defaultValue: '20',
    validate: validatePct,
  }) as string;
  if (p.isCancel(defaultReplyPctStr)) process.exit(0);

  const defaultLikePctStr = await p.text({
    message: 'Default like probability on timeline for strangers (0-100%):',
    placeholder: '80',
    defaultValue: '80',
    validate: validatePct,
  }) as string;
  if (p.isCancel(defaultLikePctStr)) process.exit(0);

  // VIP list
  const vipList = await collectVipList();

  // Spontaneous tweet cooldown
  p.log.message('');
  p.log.message(pc.bold('💬 Spontaneous Tweet Schedule'));

  const cooldownDaysStr = await p.text({
    message: 'Minimum days between spontaneous tweets:',
    placeholder: '3',
    defaultValue: '3',
    validate: validatePositiveInt,
  }) as string;
  if (p.isCancel(cooldownDaysStr)) process.exit(0);

  // Timeline engagement frequency
  const timelineHoursStr = await p.text({
    message: 'Timeline engagement check interval (hours):',
    placeholder: '1',
    defaultValue: '1',
    validate: (v: string | undefined) => {
      if (v == null) return 'Enter a positive whole number (minimum 1)';
      const n = Number(v);
      if (isNaN(n) || n < 1 || !Number.isInteger(n)) return 'Enter a positive whole number (minimum 1)';
      return undefined;
    },

  }) as string;
  if (p.isCancel(timelineHoursStr)) process.exit(0);

  const timelineHours = Number(timelineHoursStr);
  const timelineCron = hoursToTimelineEngagementCron(timelineHours);

  const cronSchedules: CronSchedules = {
    mentionPoll: '* * * * *',
    spontaneous: '30 12 * * *',
    timelineEngagement: timelineCron,
    memoryRefresh: '0 */6 * * *',
    nightlyEvolution: '0 3 * * *',
  };

  p.log.message('');
  p.log.success(pc.green(`Economy configured: reply=${Math.round(pct(defaultReplyPctStr) * 100)}%, like=${Math.round(pct(defaultLikePctStr) * 100)}%, ${vipList.length} VIP(s)`));
  p.log.message(pc.dim(`Timeline engagement cron: ${timelineCron} (every ${timelineHours}h)`));

  return {
    defaultReplyProbability: pct(defaultReplyPctStr),
    defaultLikeProbability: pct(defaultLikePctStr),
    vipList,
    spontaneousCooldownDays: Number(cooldownDaysStr),
    cronSchedules,
  };
}
