// Local copy of worker types needed by the wizard — kept in sync with packages/worker/src/types.ts

export interface VipEntry {
  username: string;
  replyProbability: number;
  likeProbability: number;
  persona?: string | undefined;
  personaInstruction?: string | undefined;
}

export interface CronSchedules {
  mentionPoll: string;
  spontaneous: string;
  timelineEngagement: string;
  memoryRefresh: string;
  nightlyEvolution: string;
}

export interface AgentConfig {
  agentName: string;
  agentHandle: string;
  sourceAccounts: string[];
  defaultReplyProbability: number;
  defaultLikeProbability: number;
  vipList: VipEntry[];
  memoryWhitelist: string[] | 'all';
  enableNightlyEvolution: boolean;
  spontaneousCooldownDays: number;
  cronSchedules: CronSchedules;
}

