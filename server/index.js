const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
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
