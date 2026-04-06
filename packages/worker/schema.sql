-- packages/worker/schema.sql
DROP TABLE IF EXISTS agents;
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  agent_name TEXT,
  agent_handle TEXT,
  source_accounts TEXT, -- JSON array
  gemini_model TEXT,
  gemini_api_key TEXT,
  refresh_token TEXT,
  access_token TEXT,
  token_expires_at INTEGER,
  skill_text TEXT,
  reply_pct REAL,
  like_pct REAL,
  cooldown_days INTEGER,
  auto_evo BOOLEAN,
  vip_list TEXT, -- JSON array
  mem_whitelist TEXT, -- JSON generic or specific
  created_at INTEGER,
  status TEXT DEFAULT 'active'
);
