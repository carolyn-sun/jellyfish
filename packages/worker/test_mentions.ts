import { getMentions } from './src/twitter.ts';
import { getValidAccessToken } from './src/auth.ts';
import { Env, AgentDbRecord } from './src/types.ts';

// Mock env
const env = {
  DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) },
  AGENT_STATE: { get: async () => null, put: async () => {}, delete: async () => {} },
  X_CLIENT_ID: process.env.X_CLIENT_ID,
  X_CLIENT_SECRET: process.env.X_CLIENT_SECRET
} as unknown as Env;

const agent = {
  id: 'c0edcfec-aaf8-4735-b3b3-7841f3c89674',
  refresh_token: process.env.REFRESH_TOKEN, // NEED to get this from DB
} as AgentDbRecord;

// Wait, I can't run this easily because of SQLite D1 bindings.
