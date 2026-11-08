const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

const { computeDashboardData, getSettingsMap } = require('./analytics');
const {
  approveTriageItem,
  dismissTriageItem,
  undoTriageAction,
  updateCategoryConfig,
  updateSettings,
  triggerMcpSync,
  generateBriefing,
  ingestAgentBriefing,
  sendWebhookNotification
} = require('./mcp-actions');
const { db } = require('./db');

const PORT = Number(process.env.PORT || 3080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 25 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

async function callMcpJsonRpc(accessToken, sessionId, method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${accessToken}`
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const resp = await fetch('https://api.monarch.com/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now() + Math.floor(Math.random() * 1000),
      method,
      params
    })
  });

  const newSessionId = resp.headers.get('mcp-session-id') || sessionId;
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`MCP ${method} failed (HTTP ${resp.status}): ${text.slice(0, 240)}`);
  }

  let parsed = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      if (dataStr) {
        try { parsed = JSON.parse(dataStr); } catch {}
      }
    }
  }
  if (!parsed) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  return { sessionId: newSessionId, body: parsed };
}

function extractMcpToolJson(rpcResult) {
  const content = rpcResult?.body?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item.text === 'string') {
        try { return JSON.parse(item.text); } catch { return item.text; }
      }
    }
  }
  return rpcResult?.body?.result || rpcResult?.body || null;
}

function findArraysInObject(obj, results = []) {
  if (!obj || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === 'object') results.push(obj);
    return results;
  }
  for (const val of Object.values(obj)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      results.push(val);
    } else if (val && typeof val === 'object') {
      findArraysInObject(val, results);
    }
  }
  return results;
}

function transformMcpResultsToAppState(rawResults) {
  const palette = ['#10b981', '#06b6d4', '#38bdf8', '#f59e0b', '#f43f5e', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#3b82f6'];
  const fixedKeywords = ['mortgage', 'rent', 'utilities', 'utility', 'electric', 'water', 'gas', 'internet', 'fiber', 'phone', 'insurance', 'auto', 'car', 'loan', 'childcare', 'daycare', 'tuition', 'hoa', 'tax', 'subscription'];

  const accounts = [];
  const categoriesMap = new Map();
  const transactions = [];
  const recurring = [];
  const triage = [];
  let totalPositiveIncome = 0;

  const allArrays = findArraysInObject(rawResults);
  for (const arr of allArrays) {
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;

      // Detect Account-like object
      if ((item.displayName || item.name) && (item.currentBalance !== undefined || item.balance !== undefined || item.type)) {
        const name = String(item.displayName || item.name);
        const bal = Number(item.currentBalance ?? item.balance ?? item.displayBalance ?? 0);
        const rawType = String(item.type?.name || item.type || item.subtype?.name || item.subtype || '').toLowerCase();
        const inst = String(item.institution?.name || item.institution || name.split(' ')[0]);
        if (!accounts.some(a => a.name === name)) {
          const typeLabel = rawType.includes('401') || rawType.includes('ira') || rawType.includes('retirement') ? 'Retirement'
            : rawType.includes('brokerage') || rawType.includes('invest') || rawType.includes('stock') ? 'Investments'
            : rawType.includes('saving') || rawType.includes('hysa') || name.toLowerCase().includes('savings') ? 'Cash (HYSA)'
            : rawType.includes('credit') || rawType.includes('card') ? 'Credit Card'
            : rawType.includes('loan') || rawType.includes('mortgage') ? 'Loan'
            : 'Cash';
          accounts.push({
            name,
            inst,
            type: typeLabel,
            apy: typeLabel.includes('HYSA') ? '4.50%' : '—',
            bal: (typeLabel === 'Credit Card' || typeLabel === 'Loan') && bal > 0 ? -bal : bal,
            owner: 'joint'
          });
        }
      }

      // Detect Transaction-like object
      if (item.amount !== undefined && (item.merchant || item.plaidName || item.description || item.date)) {
        const amt = Number(item.amount || 0);
        const dt = String(item.date || new Date().toISOString().slice(0, 10));
        const merch = String(item.merchant?.name || item.merchant || item.description || item.plaidName || 'Merchant');
        const catName = String(item.category?.name || item.category || 'Uncategorized');
        const acctName = String(item.account?.displayName || item.account?.name || item.account || 'Account');

        if (amt > 0 && (catName.toLowerCase().includes('paycheck') || catName.toLowerCase().includes('income') || amt >= 500)) {
          totalPositiveIncome += amt;
          continue;
        }
        const spend = Math.abs(amt);
        if (spend === 0 || catName.toLowerCase().includes('transfer') || catName.toLowerCase().includes('credit card payment')) continue;

        if (!categoriesMap.has(catName)) {
          const isFixed = fixedKeywords.some(k => catName.toLowerCase().includes(k));
          categoriesMap.set(catName, {
            id: 'cat_' + catName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
            name: catName,
            icon: isFixed ? '🏠' : '💳',
            group: isFixed ? 'Fixed Baseline' : 'Flexible Living',
            type: isFixed ? 'fixed' : 'disc',
            color: palette[categoriesMap.size % palette.length],
            total: 0,
            mtd: 0
          });
        }
        const cObj = categoriesMap.get(catName);
        cObj.total += spend;
        cObj.mtd += spend;

        if (transactions.length < 40) {
          transactions.push({
            id: String(item.id || 'tx_' + transactions.length),
            date: dt.slice(5),
            merchant: merch,
            catId: cObj.id,
            amount: Math.round(spend * 100) / 100,
            account: acctName,
            owner: 'joint',
            avatar: merch.slice(0, 1).toUpperCase(),
            color: cObj.color,
            tag: '#MonarchMCP'
          });
        }

        if (triage.length < 10 && catName.toLowerCase().includes('uncategorized')) {
          triage.push({
            id: 'tri_' + (triage.length + 1),
            date: dt.slice(5),
            fullDate: dt,
            amount: Math.round(spend * 100) / 100,
            avatar: merch.slice(0, 1).toUpperCase(),
            avatarBg: cObj.color,
            account: acctName,
            owner: 'joint',
            catId: cObj.id,
            issue: 'Uncategorized',
            confidence: 93,
            before: { merchant: merch, category: 'Uncategorized', tags: 'None' },
            after: { merchant: merch, category: 'Shopping & General', tags: '#Reviewed' },
            reason: `Synced from Monarch MCP (${dt})`,
            status: 'staged'
          });
        }
      }
    }
  }

  const categories = Array.from(categoriesMap.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 14)
    .map(c => {
      const avg = Math.max(25, Math.round(c.total));
      return {
        id: c.id,
        name: c.name,
        icon: c.icon,
        group: c.group,
        type: c.type,
        color: c.color,
        budget: Math.round(avg * 1.05),
        mtd: Math.round(c.mtd),
        avg: { all: avg, joint: avg, partner_a: Math.round(avg * 0.5), partner_b: Math.round(avg * 0.5) },
        hist: [avg, avg, avg, avg, avg, Math.round(c.mtd)],
        merchants: [{ n: c.name, v: '$' + avg.toLocaleString(), cnt: 'MCP Sync' }]
      };
    });

  const statePatch = { isRealData: true, lastImportedAt: new Date().toISOString() };
  if (totalPositiveIncome > 0) {
    const inc = Math.round(totalPositiveIncome);
    statePatch.monthlyIncome = { all: inc, joint: inc, partner_a: Math.round(inc * 0.55), partner_b: Math.round(inc * 0.45) };
  }
  if (accounts.length) statePatch.accounts = accounts;
  if (categories.length) statePatch.categories = categories;
  if (transactions.length) statePatch.transactions = transactions;
  if (recurring.length) statePatch.recurring = recurring;
  if (triage.length) statePatch.triage = triage;
  return statePatch;
}

async function syncLiveFromMonarchMcp(accessToken) {
  const initRes = await callMcpJsonRpc(accessToken, null, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'monarch-smart-cfo', version: '1.0.0' }
  });
  const sid = initRes.sessionId;
  try {
    await callMcpJsonRpc(accessToken, sid, 'notifications/initialized', {});
  } catch {}

  const listRes = await callMcpJsonRpc(accessToken, sid, 'tools/list', {});
  const tools = listRes?.body?.result?.tools || [];
  const toolNames = tools.map(t => t.name);

  const rawResults = {};
  for (const t of tools) {
    const n = t.name.toLowerCase();
    if (n.includes('account') || n.includes('categor') || n.includes('budget') || n.includes('recurring') || n.includes('transaction') || n.includes('cashflow')) {
      try {
        const res = await callMcpJsonRpc(accessToken, sid, 'tools/call', { name: t.name, arguments: {} });
        rawResults[t.name] = extractMcpToolJson(res);
      } catch (err) {
        rawResults[t.name] = { error: err.message };
      }
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at)
    VALUES ('monarch_mcp_raw_dump', ?, datetime('now'))
  `).run(JSON.stringify({ syncedAt: new Date().toISOString(), toolNames, rawResults }));

  const statePatch = transformMcpResultsToAppState(rawResults);
  if (statePatch.accounts || statePatch.categories || statePatch.transactions) {
    const existingRow = db.prepare(`SELECT value FROM settings WHERE key = 'live_app_state_json'`).get();
    const existing = existingRow && existingRow.value ? JSON.parse(existingRow.value) : {};
    const merged = { ...existing, ...statePatch };
    db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES ('live_app_state_json', ?, datetime('now'))
    `).run(JSON.stringify(merged));
  }

  return { toolNames, rawResults, statePatch };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Optional API Key gate if CFO_API_KEY is set when exposing via Cloudflare Tunnel
  const requiredApiKey = process.env.CFO_API_KEY;
  if (requiredApiKey && pathname.startsWith('/api/') && pathname !== '/api/health') {
    const authHeader = req.headers['authorization'] || '';
    const xApiKey = req.headers['x-api-key'] || parsedUrl.searchParams.get('api_key') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim() || xApiKey;
    if (token !== requiredApiKey) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized: valid CFO_API_KEY required.' });
    }
  }

  try {
    // 1. Healthcheck
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok', service: 'monarch-smart-cfo', timestamp: new Date().toISOString() });
    }

    // 1a. Monarch OAuth 2.1 PKCE Start & Exchange
    if (req.method === 'POST' && pathname === '/api/oauth/start') {
      const redirectUri = 'http://localhost:3080/callback';
      const regResp = await fetch('https://api.monarch.com/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Monarch Smart CFO (Unraid)',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        })
      });
      const regData = await regResp.json();
      if (!regResp.ok || !regData.client_id) {
        throw new Error(`Monarch OAuth client registration failed: ${JSON.stringify(regData)}`);
      }
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const state = crypto.randomBytes(16).toString('hex');

      db.prepare(`
        INSERT OR REPLACE INTO settings (key, value, updated_at)
        VALUES ('monarch_oauth_pkce_state', ?, datetime('now'))
      `).run(JSON.stringify({ client_id: regData.client_id, code_verifier: codeVerifier, redirect_uri: redirectUri, state }));

      const authParams = new URLSearchParams({
        response_type: 'code',
        client_id: regData.client_id,
        redirect_uri: redirectUri,
        scope: 'mcp:read mcp:write',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource: 'https://api.monarch.com/mcp'
      });

      return sendJson(res, 200, {
        ok: true,
        authUrl: `https://api.monarch.com/oauth/authorize/?${authParams.toString()}`
      });
    }

    if (req.method === 'POST' && pathname === '/api/oauth/exchange') {
      const body = await parseBody(req);
      const rawInput = String(body.callbackUrlOrCode || '').trim();
      if (!rawInput) throw new Error('Please paste the redirect URL or authorization code.');

      let code = rawInput;
      if (rawInput.includes('code=')) {
        const u = new URL(rawInput.startsWith('http') ? rawInput : `http://localhost/${rawInput}`);
        code = u.searchParams.get('code') || rawInput;
      }

      const pkceRow = db.prepare(`SELECT value FROM settings WHERE key = 'monarch_oauth_pkce_state'`).get();
      if (!pkceRow || !pkceRow.value) {
        throw new Error('No active OAuth session found. Click Step 1 (Open Monarch Login) first.');
      }
      const pkce = JSON.parse(pkceRow.value);

      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: pkce.client_id,
        code,
        redirect_uri: pkce.redirect_uri,
        code_verifier: pkce.code_verifier,
        resource: 'https://api.monarch.com/mcp'
      });

      const tokResp = await fetch('https://api.monarch.com/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString()
      });
      const tokData = await tokResp.json();
      if (!tokResp.ok || !tokData.access_token) {
        throw new Error(`Token exchange failed: ${JSON.stringify(tokData)}`);
      }

      db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('monarch_oauth_token', ?, datetime('now'))`).run(tokData.access_token);
      db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('monarch_connection_mode', 'connected', datetime('now'))`).run();

      const mcpSync = await syncLiveFromMonarchMcp(tokData.access_token);
      return sendJson(res, 200, {
        ok: true,
        message: 'Monarch OAuth connected & MCP tools queried!',
        toolNames: mcpSync.toolNames,
        statePatch: mcpSync.statePatch
      });
    }

    // 1b. Persistent Live App State (SQLite-backed for imported Monarch CSV / MCP data)
    if (req.method === 'GET' && pathname === '/api/app-state') {
      const row = db.prepare(`SELECT value, updated_at FROM settings WHERE key = 'live_app_state_json'`).get();
      if (!row || !row.value) {
        return sendJson(res, 200, { ok: true, hasCustomState: false, state: null });
      }
      return sendJson(res, 200, { ok: true, hasCustomState: true, updatedAt: row.updated_at, state: JSON.parse(row.value) });
    }

    if (req.method === 'POST' && (pathname === '/api/app-state' || pathname === '/api/import')) {
      const body = await parseBody(req);
      const existingRow = db.prepare(`SELECT value FROM settings WHERE key = 'live_app_state_json'`).get();
      const existing = existingRow && existingRow.value ? JSON.parse(existingRow.value) : {};
      const incoming = body.state || body;
      const merged = {
        ...existing,
        ...incoming,
        isRealData: true,
        lastImportedAt: new Date().toISOString()
      };
      db.prepare(`
        INSERT OR REPLACE INTO settings (key, value, updated_at)
        VALUES ('live_app_state_json', ?, datetime('now'))
      `).run(JSON.stringify(merged));
      return sendJson(res, 200, { ok: true, message: 'Saved real Monarch data to Unraid SQLite database.', state: merged });
    }

    if (req.method === 'DELETE' && pathname === '/api/app-state') {
      db.prepare(`DELETE FROM settings WHERE key = 'live_app_state_json'`).run();
      return sendJson(res, 200, { ok: true, message: 'Reset to default demo dataset.' });
    }

    // 2. Dashboard Payload
    if (req.method === 'GET' && pathname === '/api/dashboard') {
      const owner = parsedUrl.searchParams.get('owner') || 'all';
      const months = Number(parsedUrl.searchParams.get('months') || 6);
      const data = computeDashboardData({ owner, windowMonths: months });
      return sendJson(res, 200, data);
    }

    // 3. Approve single triage item
    const approveMatch = pathname.match(/^\/api\/triage\/([^/]+)\/approve$/);
    if (req.method === 'POST' && approveMatch) {
      const result = await approveTriageItem(decodeURIComponent(approveMatch[1]));
      return sendJson(res, 200, result);
    }

    // 4. Dismiss single triage item
    const dismissMatch = pathname.match(/^\/api\/triage\/([^/]+)\/dismiss$/);
    if (req.method === 'POST' && dismissMatch) {
      const result = dismissTriageItem(decodeURIComponent(dismissMatch[1]));
      return sendJson(res, 200, result);
    }

    // 5. Approve all staged triage items
    if (req.method === 'POST' && pathname === '/api/triage/approve-all') {
      const staged = db.prepare(`SELECT id FROM triage_queue WHERE status = 'staged'`).all();
      const results = [];
      for (const row of staged) {
        results.push(await approveTriageItem(row.id));
      }
      return sendJson(res, 200, { ok: true, approved_count: results.length });
    }

    // 6. Undo a previously approved triage item
    const undoMatch = pathname.match(/^\/api\/undo\/([^/]+)$/);
    if (req.method === 'POST' && undoMatch) {
      const result = await undoTriageAction(decodeURIComponent(undoMatch[1]));
      return sendJson(res, 200, result);
    }

    // 7. Update Category Fixed vs. Discretionary or Monthly Budget
    const catMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
    if ((req.method === 'PATCH' || req.method === 'POST') && catMatch) {
      const body = await parseBody(req);
      const result = updateCategoryConfig(decodeURIComponent(catMatch[1]), body);
      return sendJson(res, 200, result);
    }

    // 8. Trigger Monarch MCP Sync
    if (req.method === 'POST' && pathname === '/api/sync') {
      const result = await triggerMcpSync();
      return sendJson(res, 200, result);
    }

    // 9. Generate Personal CFO Briefing
    if (req.method === 'POST' && pathname === '/api/briefings/generate') {
      const body = await parseBody(req);
      const result = await generateBriefing(body);
      return sendJson(res, 200, result);
    }

    // 10. Agent-Pushed CFO Briefing Endpoint
    if (req.method === 'POST' && pathname === '/api/briefings/agent-push') {
      const body = await parseBody(req);
      const result = ingestAgentBriefing(body);
      return sendJson(res, 200, result);
    }

    // 11. Save Settings
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await parseBody(req);
      const settings = updateSettings(body);
      return sendJson(res, 200, { ok: true, settings });
    }

    // 12. Test Webhook Alert
    if (req.method === 'POST' && pathname === '/api/webhooks/test') {
      const body = await parseBody(req);
      const settings = { ...getSettingsMap(), ...body };
      if (!settings.webhook_url || settings.webhook_type === 'none') {
        return sendJson(res, 400, { ok: false, error: 'Please select a webhook type and enter a webhook URL first.' });
      }
      const resHook = await sendWebhookNotification(settings, {
        title: '🔔 Monarch Smart CFO — Unraid Test Alert',
        headline: 'Your Unraid Smart Finance Dashboard webhook is connected!',
        summary: 'Weekly CFO briefings, subscription price hikes, and duplicate charge anomalies will be delivered to this channel.',
        actionItems: [
          { priority: 'high', category: 'Cash Optimization', title: 'Sweep $10,280 idle checking cash to HYSA', impact: '+$462/yr', detail: 'Test notification payload' }
        ]
      });
      return sendJson(res, 200, resHook);
    }

    // Static Files
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Monarch Smart CFO Server listening on http://0.0.0.0:${PORT}`);
});
