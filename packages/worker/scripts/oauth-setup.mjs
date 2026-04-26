#!/usr/bin/env node
/**
 * One-time OAuth 2.0 PKCE setup script.
 *
 * Usage:
 *   node scripts/oauth-setup.mjs
 *   X_CLIENT_ID=xxx X_CLIENT_SECRET=yyy node scripts/oauth-setup.mjs
 *
 * This script will:
 *  1. Build the X authorization URL with PKCE
 *  2. Spin up a local callback server on localhost:3000
 *  3. Wait for you to authorize with your Agent's X account in the browser
 *  4. Exchange the code for tokens
 *  5. Print the refresh_token you need to set as a Wrangler secret
 */

import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';

const CLIENT_ID = process.env.X_CLIENT_ID;
const CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/callback';
const PORT = 3000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  Missing required environment variables.');
  console.error('   Usage: X_CLIENT_ID=xxx X_CLIENT_SECRET=yyy node scripts/oauth-setup.mjs');
  process.exit(1);
}

// ── Generate PKCE ─────────────────────────────────────────────────────────────
const codeVerifier = crypto.randomBytes(32).toString('base64url');
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

// ── Build authorization URL ───────────────────────────────────────────────────
const authUrl = new URL('https://twitter.com/i/oauth2/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access');
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

console.log('\n🔗  请在浏览器中打开以下 URL，用 Agent 的 X 账号授权：\n');
console.log('   ' + authUrl.toString());
console.log('\n⏳  等待回调中，请授权后稍候...\n');

// Try to auto-open the browser
const opener =
  process.platform === 'darwin' ? 'open' :
  process.platform === 'win32'  ? 'start' : 'xdg-open';
exec(`${opener} "${authUrl.toString()}"`);

// ── Local callback server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== '/callback') {
    res.writeHead(404); res.end('Not found'); return;
  }

  const code          = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (returnedState !== state) {
    res.writeHead(400); res.end('State mismatch — possible CSRF attack');
    console.error('❌  State mismatch'); server.close(); return;
  }
  if (!code) {
    res.writeHead(400); res.end('No authorization code in callback');
    console.error('❌  No code received'); server.close(); return;
  }

  // ── Exchange code for tokens ──────────────────────────────────────────────
  console.log('🔄  Exchanging authorization code for tokens...');

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: CLIENT_ID,
    }).toString(),
  });

  const data = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error('❌  Token exchange failed:', JSON.stringify(data, null, 2));
    res.writeHead(500); res.end('Token exchange failed — check terminal.');
    server.close(); return;
  }

  // ── Success ───────────────────────────────────────────────────────────────
  console.log('\n✅  授权成功。\n');
  console.log('━'.repeat(60));
  console.log(`X_CLIENT_ID     : ${CLIENT_ID}`);
  console.log(`X_REFRESH_TOKEN : ${data.refresh_token}`);
  console.log('━'.repeat(60));
  console.log('\n▶  设置 Cloudflare Worker 密钥：\n');
  console.log(`  npx wrangler secret put X_CLIENT_ID`);
  console.log(`  npx wrangler secret put X_CLIENT_SECRET`);
  console.log(`  npx wrangler secret put X_REFRESH_TOKEN`);
  console.log(`\n  值 (X_REFRESH_TOKEN) : ${data.refresh_token}\n`);

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>授权成功</title>
<style>body{font-family:system-ui,sans-serif;padding:48px;max-width:560px;margin:auto}
h2{color:#16a34a}</style></head>
<body>
  <h2>✅ 授权成功。</h2>
  <p>请回到终端查看你的 <strong>refresh_token</strong>，然后按照提示设置 Wrangler Secrets。</p>
  <p style="color:#6b7280">这个页面可以关闭了。</p>
</body></html>`);

  server.close(() => {
    console.log('✅  脚本完成，服务已关闭。');
  });
});

server.listen(PORT, () => {
  console.log(`📡  本地回调服务已启动在 http://localhost:${PORT}`);
});
