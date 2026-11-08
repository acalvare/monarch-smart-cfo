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
    'Authorization': `Bearer ${accessToken}`,
    'MCP-Protocol-Version': '2025-03-26'
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const isNotification = method.startsWith('notifications/');
  const reqId = isNotification ? undefined : Date.now() + Math.floor(Math.random() * 10000);
  const rpcPayload = {
    jsonrpc: '2.0',
    ...(reqId !== undefined ? { id: reqId } : {}),
    method,
    params
  };

  const resp = await fetch('https://api.monarch.com/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcPayload)
  });

  const newSessionId = resp.headers.get('mcp-session-id') || sessionId;
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`MCP ${method} failed (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
  if (!text || !text.trim()) {
    return { sessionId: newSessionId, body: { result: {} } };
  }

  let parsed = null;
  const sseObjects = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const dataStr = line.slice(5).trim();
      if (dataStr) {
        try {
          sseObjects.push(JSON.parse(dataStr));
        } catch {}
      }
    }
  }
  if (sseObjects.length > 0) {
    parsed =
      sseObjects.find(o => o && reqId !== undefined && o.id === reqId) ||
      sseObjects.find(o => o && (o.result !== undefined || o.error !== undefined)) ||
      sseObjects[sseObjects.length - 1];
  }
  if (!parsed) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { sessionId: newSessionId, body: parsed };
}

function tryParseEmbeddedJson(str) {
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }
  const firstBrace = trimmed.search(/[\[{]/);
  const lastBracket = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (firstBrace !== -1 && lastBracket > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBracket + 1));
    } catch {}
  }
  return trimmed;
}

function extractMcpToolJson(rpcResult) {
  if (rpcResult?.body?.error) {
    return { mcpError: rpcResult.body.error };
  }
  const resObj = rpcResult?.body?.result;
  if (!resObj) return rpcResult?.body || null;

  const extracted = [];
  if (resObj.structuredContent && typeof resObj.structuredContent === 'object') {
    extracted.push(resObj.structuredContent);
  }
  if (Array.isArray(resObj.content)) {
    for (const item of resObj.content) {
      if (item && typeof item.text === 'string') {
        extracted.push(tryParseEmbeddedJson(item.text));
      } else if (item && item.data) {
        extracted.push(item.data);
      }
    }
  }
  if (extracted.length === 1) return extracted[0];
  if (extracted.length > 1) return extracted;
  return resObj;
}

function parseMoney(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val !== 'string') return 0;
  const s = val.trim();
  if (!s) return 0;
  const isParenNeg = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return 0;
  return isParenNeg ? -Math.abs(num) : num;
}

function parseMarkdownTablesAndBullets(text, sourceKey = '') {
  if (typeof text !== 'string' || !text.trim() || text.startsWith('ERROR:')) return [];
  const items = [];
  const lines = text.split(/\r?\n/);

  // 1. Parse Markdown tables (| Col1 | Col2 | ...)
  let headers = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|') && line.split('|').length >= 4) {
      const cells = line.slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) continue;
      const nextLine = (lines[i + 1] || '').trim();
      if (!headers && nextLine.startsWith('|') && /^[\s|:-]+$/.test(nextLine)) {
        headers = cells.map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
        continue;
      }
      if (headers && cells.length === headers.length) {
        const obj = { _source: sourceKey };
        headers.forEach((h, idx) => {
          obj[h] = cells[idx].replace(/\*\*/g, '').trim();
        });
        items.push(obj);
      }
    } else if (!line.startsWith('|')) {
      headers = null;
    }
  }

  // 2. Parse Markdown bullets or lines with dollar amounts
  const skLower = sourceKey.toLowerCase();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('|') || line.startsWith('#')) continue;
    const moneyMatch = line.match(/(-?\$[0-9,]+(?:\.[0-9]{1,2})?|\(\$[0-9,]+(?:\.[0-9]{1,2})?\))/);
    if (!moneyMatch) continue;
    const amountVal = parseMoney(moneyMatch[1]);
    const dateMatch = line.match(/\b(202[0-9]-[01][0-9]-[0-3][0-9])\b/);

    if (dateMatch || skLower.includes('transaction')) {
      const cleaned = line
        .replace(dateMatch ? dateMatch[0] : '', '')
        .replace(moneyMatch[0], '')
        .replace(/^[-*•\d.)\s:]+/, '')
        .replace(/\*\*/g, '')
        .trim();
      const parts = cleaned.split(/\s+(?:[-–—•|]|at|in)\s+|\s*\(([^)]+)\)\s*/).filter(Boolean);
      items.push({
        _source: sourceKey,
        date: dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10),
        merchant: parts[0] || 'Monarch Transaction',
        category: parts[1] || 'General',
        amount: amountVal
      });
    } else if (skLower.includes('account') || skLower.includes('balance')) {
      const cleaned = line
        .replace(moneyMatch[0], '')
        .replace(/^[-*•\d.)\s:]+/, '')
        .replace(/\*\*/g, '')
        .replace(/[:\-–—]+\s*$/, '')
        .trim();
      if (cleaned && cleaned.length < 90 && !/^(total|net worth|assets|liabilities|summary)/i.test(cleaned)) {
        items.push({
          _source: sourceKey,
          displayName: cleaned,
          currentBalance: amountVal,
          type: cleaned
        });
      }
    } else if (skLower.includes('budget') || skLower.includes('spendingbycategory') || skLower.includes('categor')) {
      const cleaned = line
        .replace(moneyMatch[0], '')
        .replace(/^[-*•\d.)\s:]+/, '')
        .replace(/\*\*/g, '')
        .replace(/[:\-–—]+\s*$/, '')
        .trim();
      if (cleaned && cleaned.length < 70 && !/^(total|income|savings|net|summary)/i.test(cleaned)) {
        items.push({
          _source: sourceKey,
          category_name: cleaned,
          actual_amount: Math.abs(amountVal)
        });
      }
    }
  }

  return items;
}

function collectCandidateObjects(node, sourceKey = '', out = [], seen = new Set()) {
  if (!node) return out;
  if (typeof node === 'string') {
    if (node.startsWith('ERROR:')) return out;
    const parsed = tryParseEmbeddedJson(node);
    if (typeof parsed === 'object' && parsed !== null) {
      return collectCandidateObjects(parsed, sourceKey, out, seen);
    }
    const mdItems = parseMarkdownTablesAndBullets(node, sourceKey);
    for (const item of mdItems) out.push(item);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const el of node) {
      collectCandidateObjects(el, sourceKey, out, seen);
    }
    return out;
  }

  if (node.node && typeof node.node === 'object') {
    collectCandidateObjects(node.node, sourceKey, out, seen);
  }

  out.push({ ...node, _source: node._source || sourceKey });

  for (const [k, v] of Object.entries(node)) {
    if (v && (typeof v === 'object' || typeof v === 'string')) {
      collectCandidateObjects(v, `${sourceKey}.${k}`, out, seen);
    }
  }
  return out;
}

function transformMcpResultsToAppState(rawResults) {
  const palette = ['#10b981', '#06b6d4', '#38bdf8', '#f59e0b', '#f43f5e', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308', '#3b82f6'];
  const fixedKeywords = ['mortgage', 'rent', 'housing', 'utilities', 'utility', 'electric', 'water', 'gas', 'internet', 'fiber', 'phone', 'insurance', 'auto', 'car', 'loan', 'childcare', 'daycare', 'tuition', 'hoa', 'tax', 'medical', 'health', 'fitness', 'gym'];

  const accounts = [];
  const categoriesMap = new Map();
  const transactions = [];
  const recurring = [];
  const triage = [];
  const monthsSeen = new Set();
  let totalPositiveIncome = 0;
  let directMonthlyIncome = 0;

  const currentMonthPrefix = new Date().toISOString().slice(0, 7);

  function ensureCategory(rawCatName) {
    const catName = String(rawCatName || 'Uncategorized').trim() || 'Uncategorized';
    if (!categoriesMap.has(catName)) {
      const lower = catName.toLowerCase();
      const isFixed = fixedKeywords.some(k => lower.includes(k));
      const icon = lower.includes('dining') || lower.includes('restaurant') ? '🍽️'
        : lower.includes('grocer') || lower.includes('market') ? '🛒'
        : lower.includes('mortgage') || lower.includes('rent') || lower.includes('housing') ? '🏠'
        : lower.includes('auto') || lower.includes('car') || lower.includes('gas') || lower.includes('transport') ? '🚗'
        : lower.includes('util') || lower.includes('electric') || lower.includes('internet') ? '⚡'
        : lower.includes('travel') || lower.includes('flight') || lower.includes('hotel') ? '✈️'
        : lower.includes('shop') || lower.includes('amazon') || lower.includes('cloth') ? '🛍️'
        : lower.includes('sub') || lower.includes('software') || lower.includes('stream') ? '🔁'
        : lower.includes('insur') ? '🛡️'
        : lower.includes('med') || lower.includes('health') || lower.includes('fit') ? '❤️'
        : isFixed ? '🏠' : '💳';

      categoriesMap.set(catName, {
        id: 'cat_' + lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        name: catName,
        icon,
        group: isFixed ? 'Fixed Baseline' : 'Flexible Living',
        type: isFixed ? 'fixed' : 'discretionary',
        color: palette[categoriesMap.size % palette.length],
        total: 0,
        mtd: 0,
        explicitBudget: 0,
        byMonth: {},
        merchants: {}
      });
    }
    return categoriesMap.get(catName);
  }

  const allObjects = [];
  for (const [toolName, toolPayload] of Object.entries(rawResults || {})) {
    collectCandidateObjects(toolPayload, toolName, allObjects);
  }

  for (const item of allObjects) {
    if (!item || typeof item !== 'object' || item.mcpError || item.error) continue;
    const src = String(item._source || '').toLowerCase();

    if (item.totalIncome !== undefined || item.sumIncome !== undefined || item.income !== undefined || item.total_income !== undefined) {
      const incVal = parseMoney(item.totalIncome ?? item.sumIncome ?? item.income ?? item.total_income);
      if (incVal > 500) directMonthlyIncome = Math.max(directMonthlyIncome, incVal);
    }

    // 1. Detect Account-like object
    const acctNameCandidate = item.displayName || item.display_name || item.accountName || item.account_name || item.officialName || item.official_name || (item.currentBalance !== undefined || item.current_balance !== undefined || item.balance !== undefined || item.displayBalance !== undefined ? (item.name || item.account || item.title) : null);
    const hasBalanceField = item.currentBalance !== undefined || item.current_balance !== undefined || item.balance !== undefined || item.displayBalance !== undefined || item.display_balance !== undefined || item.availableBalance !== undefined;
    const hasTxDate = item.date !== undefined || item.transaction_date !== undefined || item.posted_date !== undefined;

    if (acctNameCandidate && hasBalanceField && !hasTxDate) {
      const name = String(acctNameCandidate).trim();
      if (name && name.length < 100 && name !== 'Account') {
        const bal = parseMoney(item.currentBalance ?? item.current_balance ?? item.balance ?? item.displayBalance ?? item.display_balance ?? item.availableBalance ?? 0);
        const rawType = String(
          item.type?.display || item.type?.name || item.type ||
          item.accountType || item.account_type ||
          item.subtype?.display || item.subtype?.name || item.subtype ||
          name
        ).toLowerCase();
        const inst = String(
          item.institution?.name || item.institution_name || item.institutionName ||
          item.credential?.institution?.name || item.institution || name.split(' ')[0]
        );
        const isAsset = item.isAsset !== undefined ? Boolean(item.isAsset) : !(rawType.includes('credit') || rawType.includes('card') || rawType.includes('loan') || rawType.includes('mortgage') || rawType.includes('liability'));

        if (!accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
          const typeLabel = rawType.includes('401') || rawType.includes('ira') || rawType.includes('roth') || rawType.includes('retirement') || rawType.includes('pension') ? 'Retirement'
            : rawType.includes('brokerage') || rawType.includes('invest') || rawType.includes('stock') || rawType.includes('etf') || rawType.includes('wealth') || rawType.includes('crypto') ? 'Investments'
            : rawType.includes('saving') || rawType.includes('hysa') || rawType.includes('money market') || name.toLowerCase().includes('savings') || name.toLowerCase().includes('reserve') ? 'Cash (HYSA)'
            : rawType.includes('credit') || rawType.includes('card') ? 'Credit Card'
            : rawType.includes('loan') || rawType.includes('mortgage') || rawType.includes('auto finance') ? 'Loan'
            : 'Cash';

          const signedBal = !isAsset && bal > 0 ? -bal : bal;
          accounts.push({
            name,
            inst,
            type: typeLabel,
            apy: typeLabel.includes('HYSA') ? '4.50%' : '—',
            bal: Math.round(signedBal * 100) / 100,
            owner: 'joint'
          });
        }
        continue;
      }
    }

    // 2. Detect Recurring Item object
    const isRecurringSource = src.includes('getrecurring') || src.includes('recurring') || item.isRecurring === true || item.is_recurring === true || item.frequency !== undefined || item.nextForecastedDate !== undefined || item.next_date !== undefined;
    if (isRecurringSource && (item.merchant || item.merchant_name || item.name || item.title) && (item.amount !== undefined || item.approxAmount !== undefined || item.current_amount !== undefined)) {
      const rMerch = String(item.merchant?.name || item.merchant_name || item.merchant || item.name || item.title).trim();
      const rAmt = Math.abs(parseMoney(item.amount ?? item.approxAmount ?? item.current_amount ?? 0));
      const rDate = String(item.nextForecastedDate || item.next_date || item.date || 'Monthly');
      const rCat = String(item.category?.name || item.category_name || item.category || 'Recurring Bill');
      if (rMerch && rAmt > 0 && !recurring.some(r => r.merchant.toLowerCase() === rMerch.toLowerCase())) {
        const dayNum = parseInt(rDate.slice(-2), 10);
        recurring.push({
          id: 'r_' + (recurring.length + 1),
          merchant: rMerch,
          icon: '🔁',
          color: palette[recurring.length % palette.length],
          cat: rCat,
          day: Number.isFinite(dayNum) && dayNum >= 1 && dayNum <= 31 ? dayNum : ((recurring.length * 3 + 5) % 28) + 1,
          date: rDate.length >= 10 ? rDate.slice(5) : rDate,
          owner: 'joint',
          prev: rAmt,
          curr: rAmt,
          history: [rAmt, rAmt, rAmt, rAmt, rAmt, rAmt]
        });
      }
      continue;
    }

    // 3. Detect Budget / Category Aggregate object (GetBudget, GetSpendingByCategory)
    const catBudgetName = item.category?.name || item.category_name || item.categoryName || ((item.plannedAmount !== undefined || item.planned_amount !== undefined || item.budget_amount !== undefined || item.actualAmount !== undefined || item.actual_amount !== undefined || item.total_amount !== undefined || src.includes('spendingbycategory') || src.includes('getbudget')) ? (item.name || item.category) : null);
    if (catBudgetName && typeof catBudgetName === 'string' && !hasTxDate) {
      const cLower = catBudgetName.toLowerCase();
      if (!cLower.includes('transfer') && !cLower.includes('income') && !cLower.includes('paycheck')) {
        const planned = Math.abs(parseMoney(item.plannedAmount ?? item.planned_amount ?? item.budget_amount ?? item.budget ?? item.budgeted ?? item.limit ?? 0));
        const actual = Math.abs(parseMoney(item.actualAmount ?? item.actual_amount ?? item.spent_amount ?? item.spent ?? item.total_amount ?? item.total ?? item.amount ?? 0));
        if (planned > 0 || actual > 0) {
          const cObj = ensureCategory(catBudgetName);
          if (planned > 0) cObj.explicitBudget = Math.max(cObj.explicitBudget, planned);
          if (actual > 0 && cObj.total === 0) {
            cObj.total = actual;
            cObj.mtd = Math.round(actual / 6);
          }
          continue;
        }
      }
    }

    // 4. Detect Transaction-like object (GetTransactions)
    const rawTxAmt = item.amount ?? item.transaction_amount ?? item.total_amount;
    const rawMerch = item.merchant?.name || item.merchant_name || item.merchantName || item.merchant || item.plaidName || item.plaid_name || item.description || item.original_description || (hasTxDate ? item.name : null);
    if (rawTxAmt !== undefined && (rawMerch || hasTxDate)) {
      const amt = parseMoney(rawTxAmt);
      if (amt === 0) continue;
      const dt = String(item.date || item.transaction_date || item.posted_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
      const monthKey = dt.slice(0, 7);
      const merch = String(rawMerch || 'Merchant').trim();
      const catName = String(item.category?.name || item.category_name || item.categoryName || item.category || 'Uncategorized').trim();
      const acctName = String(item.account?.displayName || item.account?.display_name || item.account?.name || item.account_name || item.accountName || item.account || 'Monarch Account').trim();
      const catLower = catName.toLowerCase();

      if (catLower.includes('transfer') || catLower.includes('credit card payment')) continue;
      if (amt > 0 && (catLower.includes('paycheck') || catLower.includes('income') || catLower.includes('salary') || catLower.includes('interest') || amt >= 400)) {
        totalPositiveIncome += amt;
        if (/^\d{4}-\d{2}$/.test(monthKey)) monthsSeen.add(monthKey);
        continue;
      }

      const spend = Math.abs(amt);
      if (/^\d{4}-\d{2}$/.test(monthKey)) monthsSeen.add(monthKey);

      const cObj = ensureCategory(catName);
      cObj.total += spend;
      cObj.byMonth[monthKey] = (cObj.byMonth[monthKey] || 0) + spend;
      if (monthKey === currentMonthPrefix) {
        cObj.mtd += spend;
      }
      cObj.merchants[merch] = (cObj.merchants[merch] || 0) + spend;

      if (transactions.length < 60) {
        transactions.push({
          id: String(item.id || 'tx_' + (transactions.length + 1)),
          date: dt.slice(5),
          fullDate: dt,
          merchant: merch,
          catId: cObj.id,
          amount: Math.round(spend * 100) / 100,
          account: acctName,
          owner: 'joint',
          avatar: merch.slice(0, 1).toUpperCase(),
          color: cObj.color,
          tag: item.isRecurring || item.is_recurring ? '#Recurring' : '#MonarchMCP'
        });
      }

      if (triage.length < 12 && (catLower.includes('uncategorized') || Boolean(item.needsReview || item.needs_review) || /^(SQ \*|TST\*|AMZN|PAYPAL \*|DD \*)/i.test(merch))) {
        const cleanMerch = merch.replace(/^(SQ \*|TST\*\s*|DD \*)/i, '').trim();
        triage.push({
          id: String(item.id || 'tri_' + (triage.length + 1)),
          date: dt.slice(5),
          fullDate: dt,
          amount: Math.round(spend * 100) / 100,
          avatar: cleanMerch.slice(0, 1).toUpperCase(),
          avatarBg: cObj.color,
          account: acctName,
          owner: 'joint',
          catId: cObj.id,
          issue: catLower.includes('uncategorized') ? 'Uncategorized' : (item.needsReview || item.needs_review) ? 'Needs Review' : 'Merchant Cleanup',
          confidence: 94,
          before: { merchant: merch, category: catName, tags: 'None' },
          after: { merchant: cleanMerch, category: catLower.includes('uncategorized') ? 'Shopping & General' : catName, tags: '#Reviewed' },
          reason: `Synced live from Monarch Money MCP (${dt})`,
          status: 'staged'
        });
      }
    }
  }

  const sortedMonths = Array.from(monthsSeen).sort().slice(-6);
  const latestMonth = sortedMonths[sortedMonths.length - 1] || currentMonthPrefix;
  const numMonths = Math.max(1, sortedMonths.length);

  const categories = Array.from(categoriesMap.values())
    .sort((a, b) => (b.total || b.mtd || b.explicitBudget) - (a.total || a.mtd || a.explicitBudget))
    .slice(0, 14)
    .map(c => {
      let history = sortedMonths.map(m => Math.round(c.byMonth[m] || 0));
      const mtdVal = Math.round(c.mtd > 0 ? c.mtd : (c.byMonth[latestMonth] || c.total / numMonths || 0));
      const avgVal = Math.max(25, Math.round(c.total > 0 ? c.total / numMonths : (c.explicitBudget || mtdVal || 100)));
      if (history.length === 0) {
        history = [avgVal, avgVal, avgVal, avgVal, avgVal, mtdVal];
      } else {
        while (history.length < 6) history.unshift(avgVal);
      }
      const budgetVal = c.explicitBudget > 0 ? Math.round(c.explicitBudget) : Math.max(50, Math.round(Math.max(avgVal, mtdVal) * 1.05));
      const topMerchants = Object.entries(c.merchants)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n, v]) => ({ n, v: '$' + Math.round(v).toLocaleString(), cnt: 'MCP Sync' }));

      return {
        id: c.id,
        name: c.name,
        icon: c.icon,
        group: c.group,
        type: c.type,
        color: c.color,
        budget: budgetVal,
        oct: history[4] || avgVal,
        mtd: mtdVal,
        avg: { all: avgVal, joint: avgVal, partner_a: Math.round(avgVal * 0.5), partner_b: Math.round(avgVal * 0.5) },
        history,
        hist: history,
        merchants: topMerchants.length ? topMerchants : [{ n: c.name, v: '$' + avgVal.toLocaleString(), cnt: 'MCP Sync' }]
      };
    });

  if (recurring.length === 0 && categories.length > 0) {
    categories.filter(c => c.type === 'fixed' || c.avg.all >= 100).slice(0, 6).forEach((c, idx) => {
      recurring.push({
        id: 'r_' + (idx + 1),
        merchant: c.merchants?.[0]?.n || c.name,
        icon: c.icon,
        color: c.color,
        cat: c.name,
        day: ((idx * 4 + 3) % 28) + 1,
        date: 'Monthly',
        owner: 'joint',
        prev: c.avg.all,
        curr: c.mtd > 0 ? c.mtd : c.avg.all,
        history: c.history
      });
    });
  }

  const totalMonthlySpend = categories.reduce((s, c) => s + c.avg.all, 0);
  const computedIncome = directMonthlyIncome > 0
    ? Math.round(directMonthlyIncome > totalMonthlySpend * 2.5 ? directMonthlyIncome / numMonths : directMonthlyIncome)
    : totalPositiveIncome > 0
    ? Math.round(totalPositiveIncome / numMonths)
    : Math.max(8000, Math.round(totalMonthlySpend * 1.25));

  const totalNetWorth = accounts.reduce((s, a) => s + Number(a.bal || 0), 0);
  const totalLiquidCash = accounts
    .filter(a => String(a.type).toLowerCase().includes('cash') && a.bal > 0)
    .reduce((s, a) => s + Number(a.bal || 0), 0);
  const topCat = categories[0];

  const briefings = [
    {
      id: 'b_live_1',
      date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      badge: 'Live Monarch MCP Executive Briefing',
      source: 'Direct Monarch Money MCP + Unraid SQLite',
      headline: `Connected to ${accounts.length} Monarch accounts (Net Worth $${Math.round(totalNetWorth).toLocaleString()}) with $${Math.round(totalLiquidCash).toLocaleString()} in liquid cash.`,
      body: `Your Unraid Smart CFO Dashboard is synced with your live Monarch Money data across ${categories.length} spending categories and ${transactions.length} recent transactions. Estimated monthly burn is $${Math.round(totalMonthlySpend).toLocaleString()}/mo against $${computedIncome.toLocaleString()}/mo estimated income.${topCat ? ` Your largest spending category is ${topCat.name} ($${topCat.mtd.toLocaleString()} MTD / $${topCat.avg.all.toLocaleString()} monthly avg).` : ''}`,
      actions: [
        ...(topCat ? [{ title: `Inspect ${topCat.name} pacing ($${topCat.mtd.toLocaleString()} MTD vs $${topCat.budget.toLocaleString()} budget)`, impact: `$${topCat.avg.all.toLocaleString()}/mo avg`, targetType: 'category', targetId: topCat.id }] : []),
        ...(triage[0] ? [{ title: `Review staged transaction: ${triage[0].before.merchant} ($${triage[0].amount.toFixed(2)})`, impact: triage[0].issue, targetType: 'triage', targetId: triage[0].id }] : []),
        { title: 'Simulate idle checking cash sweep to High-Yield Savings (HYSA)', impact: 'Optimize APY', targetType: 'insight', targetId: 'cash_sweep' }
      ]
    }
  ];

  return {
    isRealData: true,
    lastImportedAt: new Date().toISOString(),
    monthlyIncome: {
      all: computedIncome,
      joint: computedIncome,
      partner_a: Math.round(computedIncome * 0.55),
      partner_b: Math.round(computedIncome * 0.45)
    },
    accounts,
    categories,
    transactions,
    recurring,
    triage,
    briefings
  };
}

async function syncLiveFromMonarchMcp(accessToken) {
  const initRes = await callMcpJsonRpc(accessToken, null, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'monarch-smart-cfo', version: '1.1.0' }
  });
  const sid = initRes.sessionId;
  try {
    await callMcpJsonRpc(accessToken, sid, 'notifications/initialized', {});
  } catch {}

  const listRes = await callMcpJsonRpc(accessToken, sid, 'tools/list', {});
  const tools = listRes?.body?.result?.tools || [];
  const toolNames = tools.map(t => t.name);
  const toolsMeta = tools.map(t => ({
    name: t.name,
    required: t.inputSchema?.required || [],
    properties: Object.keys(t.inputSchema?.properties || {})
  }));

  const todayStr = new Date().toISOString().slice(0, 10);
  const sixMonthsAgoStr = new Date(Date.now() - 180 * 86400 * 1000).toISOString().slice(0, 10);

  // Explicit read-only tool call plan matching Monarch's required `intent`, `start_date`, and `end_date` parameters
  const readToolPlan = {
    GetAccounts: { intent: 'net_worth_tracking' },
    GetCategories: { intent: 'budgeting' },
    GetRecurring: { intent: 'bills_and_subscriptions' },
    GetBudget: { intent: 'budgeting', start_date: sixMonthsAgoStr, end_date: todayStr },
    GetCashFlow: { intent: 'cash_flow_planning', start_date: sixMonthsAgoStr, end_date: todayStr },
    GetSpendingByCategory: { intent: 'spending_analysis', start_date: sixMonthsAgoStr, end_date: todayStr },
    GetTransactions: { intent: 'spending_analysis', start_date: sixMonthsAgoStr, end_date: todayStr }
  };

  const rawResults = {};
  for (const [toolName, toolArgs] of Object.entries(readToolPlan)) {
    if (toolNames.length > 0 && !toolNames.includes(toolName)) continue;
    try {
      const res = await callMcpJsonRpc(accessToken, sid, 'tools/call', {
        name: toolName,
        arguments: toolArgs
      });
      rawResults[toolName] = extractMcpToolJson(res);
    } catch (err) {
      rawResults[toolName] = { error: err.message };
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at)
    VALUES ('monarch_mcp_raw_dump', ?, datetime('now'))
  `).run(JSON.stringify({ syncedAt: new Date().toISOString(), toolNames, toolsMeta, rawResults }));

  const statePatch = transformMcpResultsToAppState(rawResults);
  if (statePatch.accounts.length > 0 || statePatch.categories.length > 0 || statePatch.transactions.length > 0) {
    const existingRow = db.prepare(`SELECT value FROM settings WHERE key = 'live_app_state_json'`).get();
    const existing = existingRow && existingRow.value ? JSON.parse(existingRow.value) : {};
    const merged = { ...existing, ...statePatch };
    db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES ('live_app_state_json', ?, datetime('now'))
    `).run(JSON.stringify(merged));
  }

  return {
    toolNames,
    toolsMeta,
    rawResults,
    statePatch,
    counts: {
      accounts: statePatch.accounts.length,
      categories: statePatch.categories.length,
      transactions: statePatch.transactions.length,
      recurring: statePatch.recurring.length
    }
  };
}

let autoSyncAttemptedOnBoot = false;

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

    // 1a. Monarch OAuth 2.1 PKCE Start, Exchange & Re-Sync
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
      if (tokData.refresh_token) {
        db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('monarch_oauth_refresh_token', ?, datetime('now'))`).run(tokData.refresh_token);
      }
      db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('monarch_connection_mode', 'connected', datetime('now'))`).run();

      const mcpSync = await syncLiveFromMonarchMcp(tokData.access_token);
      return sendJson(res, 200, {
        ok: true,
        message: 'Monarch OAuth connected & MCP tools queried!',
        toolNames: mcpSync.toolNames,
        counts: mcpSync.counts,
        statePatch: mcpSync.statePatch
      });
    }

    if (req.method === 'POST' && pathname === '/api/oauth/resync') {
      const tokRow = db.prepare(`SELECT value FROM settings WHERE key = 'monarch_oauth_token'`).get();
      if (!tokRow || !tokRow.value) {
        throw new Error('No saved Monarch OAuth token found in SQLite. Please complete Step 1 & Step 2 first.');
      }
      const mcpSync = await syncLiveFromMonarchMcp(tokRow.value);
      return sendJson(res, 200, {
        ok: true,
        message: `Synced ${mcpSync.counts.accounts} accounts, ${mcpSync.counts.categories} categories, and ${mcpSync.counts.transactions} transactions from Monarch MCP!`,
        toolNames: mcpSync.toolNames,
        counts: mcpSync.counts,
        statePatch: mcpSync.statePatch
      });
    }

    // 1b. Persistent Live App State (SQLite-backed for imported Monarch CSV / MCP data)
    if (req.method === 'GET' && pathname === '/api/app-state') {
      let row = db.prepare(`SELECT value, updated_at FROM settings WHERE key = 'live_app_state_json'`).get();

      // If no live_app_state_json exists yet but a saved monarch_oauth_token is present, auto-sync once on boot
      if ((!row || !row.value) && !autoSyncAttemptedOnBoot) {
        const tokRow = db.prepare(`SELECT value FROM settings WHERE key = 'monarch_oauth_token'`).get();
        if (tokRow && tokRow.value) {
          autoSyncAttemptedOnBoot = true;
          try {
            await syncLiveFromMonarchMcp(tokRow.value);
            row = db.prepare(`SELECT value, updated_at FROM settings WHERE key = 'live_app_state_json'`).get();
          } catch {}
        }
      }

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
