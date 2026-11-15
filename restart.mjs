// restart.mjs — restart / start / stop the ACLClouds hosting app ("dog bot")
// via the panel power API, with Telegram notification on the result.
//
//   POST /api/client/hosting/apps/{id}/power   { "action": "restart" }
//   (verified 2026-11-15: GET on that route returns 405, same as the known
//   POST-only /renew route; the request body was captured from the panel.)
//
// Usage: node restart.mjs
// Env:
//   ACL_SERVER_ID     app id (or the repo secret of the same name)
//   ACL_USERNAME      panel login (falls back to EMAIL)
//   ACL_PASSWORD      panel password (falls back to PASSWORD)
//   ACL_BASE_URL      default https://aclclouds.com
//   RESTART_ACTION    restart | start | stop  (default restart)
//   TG_BOT_TOKEN / TG_CHAT_ID   optional Telegram notification
//   ACL_AUTH_STATE    cached Playwright session, default auth-1.json
//                     (same cache the renew workflow keeps warm)
//   DRY_RUN=1         print the request that would be sent, send nothing
//
// Exit codes: 0 restarted and verified, 2 bad/missing config or login,
//             3 power call failed or restart not verified.

import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const USERNAME = process.env.ACL_USERNAME || process.env.EMAIL || '';
const PASSWORD = process.env.ACL_PASSWORD || process.env.PASSWORD || '';
const ACTION = (process.env.RESTART_ACTION || 'restart').toLowerCase();
const DRY_RUN = process.env.DRY_RUN === '1';
const STATE_PATH = path.resolve(process.env.ACL_AUTH_STATE || 'auth-1.json');
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function fail(message, code = 2) {
  console.error(`[restart] ERROR: ${message}`);
  process.exit(code);
}

async function tg(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    });
  } catch (e) {
    log(`TG notify failed (non-fatal): ${e.message}`);
  }
}

// --- config validation (runs before any browser is launched) ---
if (!SERVER_ID) fail('missing ACL_SERVER_ID');
if (!['restart', 'start', 'stop'].includes(ACTION)) {
  fail(`bad RESTART_ACTION "${ACTION}" (want restart|start|stop)`);
}
const powerUrl = `${BASE}/api/client/hosting/apps/${SERVER_ID}/power`;
const body = { action: ACTION };

if (DRY_RUN) {
  log(`DRY_RUN: would send POST ${powerUrl}`);
  log(`DRY_RUN: body ${JSON.stringify(body)}`);
  log('DRY_RUN: nothing sent, exit 0');
  process.exit(0);
}

const hasSession = fs.existsSync(STATE_PATH);
if (!hasSession && (!USERNAME || !PASSWORD)) {
  fail('no cached session (auth-1.json) and no ACL_USERNAME/ACL_PASSWORD — run the ACLClouds Auto Renew workflow once to refresh the login session, then re-run this');
}

const { chromium } = await import('playwright');

const browser = await chromium.launch();
try {
  const context = await browser.newContext(
    hasSession ? { storageState: STATE_PATH } : {},
  );
  const page = await context.newPage();

  const api = async (p, method = 'GET', data) => {
    const headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    // CSRF token lives in the page meta tag once logged in.
    const token = await page
      .evaluate(() => document.querySelector('meta[name="csrf-token"]')?.content || '')
      .catch(() => '');
    if (token) headers['X-CSRF-TOKEN'] = token;
    const res = await page.request.fetch(`${BASE}${p}`, {
      method,
      headers,
      ...(data ? { data } : {}),
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status(), json, text: text.slice(0, 500) };
  };

  const loggedIn = async () => {
    const r = await api('/api/client/account');
    return r.status === 200 && r.json?.object === 'user';
  };

  // Warm up the page so request cookies / CSRF meta are available.
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  if (!(await loggedIn())) {
    log('cached session not logged in, trying username/password login…');
    if (!USERNAME || !PASSWORD) {
      fail('session expired and no ACL_USERNAME/ACL_PASSWORD set — run the ACLClouds Auto Renew workflow once to refresh the login session, then re-run this');
    }
    await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
    const email = page.locator('input[type="email"], input[name="email"]').first();
    const pass = page.locator('input[type="password"]').first();
    await email.fill(USERNAME);
    await pass.fill(PASSWORD);
    await page.locator('button[type="submit"]').first().click().catch(() => {});
    await page.waitForTimeout(3000);
    if (!(await loggedIn())) {
      fail('login failed (captcha or bad credentials?) — run the ACLClouds Auto Renew workflow once to refresh the login session, then re-run this');
    }
    log('login ok');
  } else {
    log('logged in via cached session');
  }

  // Baseline: how many power.<action> events exist before we call?
  const activityUrl = `/api/client/hosting/apps/${SERVER_ID}/activity`;
  const countEvents = async () => {
    const r = await api(activityUrl);
    if (r.status !== 200 || !Array.isArray(r.json?.data)) return -1;
    return r.json.data.filter((e) => e?.name === `power.${ACTION}`).length;
  };
  const before = await countEvents();
  log(`power.${ACTION} events before call: ${before}`);

  log(`POST ${powerUrl} ${JSON.stringify(body)}`);
  const res = await api(`/api/client/hosting/apps/${SERVER_ID}/power`, 'POST', body);
  if (res.status < 200 || res.status >= 300) {
    await tg(`❌ ACLClouds ${ACTION} failed: HTTP ${res.status} ${res.text}`);
    fail(`power call returned HTTP ${res.status}: ${res.text}`, 3);
  }
  log(`power call accepted (HTTP ${res.status})`);

  // Verify: a fresh power.<action> event should show up in the activity log.
  let verified = false;
  for (let i = 0; i < 12; i++) {
    await sleep(10000);
    const now = await countEvents();
    if (before >= 0 && now > before) { verified = true; break; }
    if (before < 0 && now > 0) { verified = true; break; }
    log(`waiting for power.${ACTION} event… (${i + 1}/12)`);
  }
  if (!verified) {
    await tg(`⚠️ ACLClouds ${ACTION} call accepted (HTTP ${res.status}) but no power.${ACTION} event appeared in the activity log within 2 min — check the panel`);
    fail('power call accepted but restart not verified in activity log', 3);
  }

  log(`verified: power.${ACTION} event appeared`);
  await tg(`✅ ACLClouds BOT ${ACTION} done (server ${SERVER_ID.slice(0, 8)}…)`);
  await context.storageState({ path: STATE_PATH }).catch(() => {});
} finally {
  await browser.close();
}
log('done');
