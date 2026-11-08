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

  return { toolNames, rawResults };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

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
        rawResults: mcpSync.rawResults
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
