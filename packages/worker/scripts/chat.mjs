#!/usr/bin/env node
/**
 * chat.mjs — 本地与 Jellyfish Agent 进行文字对话
 *
 * 用法：
 *   node scripts/chat.mjs [agentId] [workerUrl] [adminSecret]
 *
 * 参数（也可用环境变量）：
 *   AGENT_ID      — Agent 的 UUID（必须）
 *   WORKER_URL    — Worker 地址，默认 http://localhost:8787
 *   ADMIN_SECRET  — 若 Worker 配置了 ADMIN_SECRET，则需要提供（可选）
 *
 * 示例：
 *   AGENT_ID=abc-123 node scripts/chat.mjs
 *   node scripts/chat.mjs abc-123 http://localhost:8787
 *
 * 注意：需要先在另一个终端运行 `pnpm dev` 启动 Worker。
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ── Config ─────────────────────────────────────────────────────────────────
const agentId     = process.argv[2] || process.env.AGENT_ID;
const workerUrl   = (process.argv[3] || process.env.WORKER_URL || 'http://localhost:8787').replace(/\/$/, '');
const adminSecret = process.argv[4] || process.env.ADMIN_SECRET || '';

if (!agentId) {
  console.error('\n❌  需要提供 Agent ID。');
  console.error('    用法: node scripts/chat.mjs <agentId> [workerUrl] [adminSecret]');
  console.error('    或:   AGENT_ID=<id> node scripts/chat.mjs\n');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GRAY   = '\x1b[90m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';

function printBanner() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║       Jellyfish Agent · 本地对话模式      ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════╝${RESET}`);
  console.log(`${GRAY}  Agent ID : ${agentId}${RESET}`);
  console.log(`${GRAY}  Worker   : ${workerUrl}${RESET}`);
  console.log(`${GRAY}  输入 /quit 或 Ctrl+C 退出；输入 /clear 清除对话历史${RESET}`);
  console.log(`${GRAY}${'─'.repeat(46)}${RESET}\n`);
}

async function sendChat(message, history) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminSecret) headers['X-Admin-Secret'] = adminSecret;

  const res = await fetch(`${workerUrl}/api/agent/chat?id=${encodeURIComponent(agentId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, history }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.reply;
}

// ── Main ───────────────────────────────────────────────────────────────────
printBanner();

const rl = readline.createInterface({ input, output });

// Catch Ctrl+C gracefully
rl.on('close', () => {
  console.log(`\n${GRAY}对话已结束。${RESET}\n`);
  process.exit(0);
});

/** @type {Array<{ role: 'user'|'agent', text: string }>} */
const history = [];

while (true) {
  let userInput;
  try {
    userInput = await rl.question(`${BOLD}${YELLOW}你${RESET} › `);
  } catch {
    // readline closed (Ctrl+D)
    break;
  }

  const trimmed = userInput.trim();
  if (!trimmed) continue;

  if (trimmed === '/quit' || trimmed === '/exit') {
    console.log(`\n${GRAY}对话已结束。${RESET}\n`);
    rl.close();
    process.exit(0);
  }

  if (trimmed === '/clear') {
    history.length = 0;
    console.log(`${GRAY}  [对话历史已清除]${RESET}\n`);
    continue;
  }

  if (trimmed === '/history') {
    if (history.length === 0) {
      console.log(`${GRAY}  [暂无历史记录]${RESET}\n`);
    } else {
      console.log(`\n${GRAY}── 当前对话历史 ──${RESET}`);
      for (const turn of history) {
        const label = turn.role === 'user' ? `${YELLOW}你${RESET}` : `${GREEN}Agent${RESET}`;
        console.log(`  ${label}: ${turn.text}`);
      }
      console.log(`${GRAY}──────────────────${RESET}\n`);
    }
    continue;
  }

  // Send to worker
  process.stdout.write(`${BOLD}${GREEN}Agent${RESET} › ${GRAY}思考中…${RESET}`);
  try {
    const reply = await sendChat(trimmed, history);

    // Overwrite the "thinking…" line
    process.stdout.write(`\r${BOLD}${GREEN}Agent${RESET} › `);

    if (reply === '<skip>' || reply.trim() === '') {
      console.log(`${GRAY}（已读不回）${RESET}\n`);
      // Still record the exchange in history so context is maintained
      history.push({ role: 'user', text: trimmed });
      history.push({ role: 'agent', text: '<skip>' });
    } else {
      console.log(`${reply}\n`);
      history.push({ role: 'user', text: trimmed });
      history.push({ role: 'agent', text: reply });
    }
  } catch (err) {
    process.stdout.write('\r');
    console.error(`${RED}❌  请求失败：${err.message}${RESET}\n`);
    console.error(`${GRAY}  请确认 Worker 正在运行（pnpm dev）且 Agent ID 正确。${RESET}\n`);
  }
}
