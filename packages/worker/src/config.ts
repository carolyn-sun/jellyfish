import type { AgentConfig } from './types.ts';
import configJson from '../generated/config.json';

/**
 * The agent configuration bundled at build time from generated/config.json.
 * Run `pnpm wizard` to regenerate this file with a custom persona.
 */
export const agentConfig: AgentConfig = configJson as unknown as AgentConfig;
