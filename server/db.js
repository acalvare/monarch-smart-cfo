const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'monarch-cfo.sqlite');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for high concurrency & fast reads on Unraid appdata SSD/cache drive
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      institution TEXT NOT NULL,
      type TEXT NOT NULL, -- 'cash' | 'credit' | 'investment' | 'loan'
      subtype TEXT NOT NULL,
      balance REAL NOT NULL,
      owner TEXT NOT NULL DEFAULT 'joint', -- 'joint' | 'partner_a' | 'partner_b'
      is_liquid INTEGER NOT NULL DEFAULT 0,
      apy REAL NOT NULL DEFAULT 0.0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      group_name TEXT NOT NULL,
      spend_type TEXT NOT NULL DEFAULT 'discretionary', -- 'fixed' | 'discretionary' | 'savings_transfer' | 'income'
      monthly_budget REAL NOT NULL DEFAULT 0,
      icon TEXT DEFAULT 'receipt'
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      merchant TEXT NOT NULL,
      raw_merchant TEXT NOT NULL,
      amount REAL NOT NULL, -- positive for expenses, negative for income/credits
      category_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'joint',
      is_recurring INTEGER NOT NULL DEFAULT 0,
      needs_review INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT DEFAULT '',
      monarch_synced_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recurring_streams (
      id TEXT PRIMARY KEY,
      merchant TEXT NOT NULL,
      category_id TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      current_amount REAL NOT NULL,
      previous_amount REAL NOT NULL,
      next_due_date TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'joint',
      price_hike_detected INTEGER NOT NULL DEFAULT 0,
      account_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triage_queue (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      issue_type TEXT NOT NULL, -- 'uncategorized' | 'messy_merchant' | 'duplicate_suspect' | 'price_hike' | 'split_suggested'
      proposed_action TEXT NOT NULL, -- JSON { category_id, category_name, merchant, tags, notes, mark_reviewed }
      before_snapshot TEXT NOT NULL, -- JSON { category_id, category_name, merchant, tags, notes, needs_review }
      diff_summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.9,
      status TEXT NOT NULL DEFAULT 'staged', -- 'staged' | 'approved' | 'dismissed' | 'undone'
      created_at TEXT DEFAULT (datetime('now')),
      applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS undo_log (
      id TEXT PRIMARY KEY,
      triage_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      merchant TEXT NOT NULL,
      amount REAL NOT NULL,
      previous_state TEXT NOT NULL, -- JSON
      new_state TEXT NOT NULL, -- JSON
      diff_summary TEXT NOT NULL,
      synced_to_monarch INTEGER NOT NULL DEFAULT 0,
      applied_at TEXT DEFAULT (datetime('now')),
      reverted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cfo_briefings (
      id TEXT PRIMARY KEY,
      period_label TEXT NOT NULL,
      source TEXT NOT NULL, -- 'hybrid_auto' | 'agent_pushed' | 'deterministic'
      headline TEXT NOT NULL,
      executive_summary TEXT NOT NULL,
      action_items TEXT NOT NULL, -- JSON array
      metrics_snapshot TEXT NOT NULL, -- JSON object
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      id TEXT PRIMARY KEY,
      month TEXT NOT NULL, -- YYYY-MM
      owner TEXT NOT NULL DEFAULT 'all', -- 'all' | 'joint' | 'partner_a' | 'partner_b'
      cash_total REAL NOT NULL,
      investment_total REAL NOT NULL,
      debt_total REAL NOT NULL,
      net_worth REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL,
      mcp_calls_used INTEGER NOT NULL DEFAULT 0,
      records_synced INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function seedIfNeeded() {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM categories`).get();
  if (row && row.cnt > 0) return;

  // 1. Default Settings
  const defaultSettings = {
    monarch_mcp_url: process.env.MONARCH_MCP_URL || 'https://api.monarch.com/mcp',
    monarch_connection_mode: process.env.MONARCH_OAUTH_TOKEN ? 'connected' : 'demo',
    monarch_oauth_token: process.env.MONARCH_OAUTH_TOKEN || '',
    monarch_write_scope_enabled: process.env.MONARCH_WRITE_ENABLED || 'true',
    sync_schedule: process.env.SYNC_CRON || '0 6 * * *',
    weekly_mcp_quota_limit: '150',
    weekly_mcp_calls_used: '14',
    partner_a_name: process.env.PARTNER_A_NAME || 'Partner A',
    partner_b_name: process.env.PARTNER_B_NAME || 'Partner B',
    emergency_fund_months_target: '6',
    checking_safety_buffer: process.env.CHECKING_SAFETY_BUFFER || '3500',
    hysa_target_apy: process.env.HYSA_TARGET_APY || '4.50',
    llm_provider: process.env.LLM_PROVIDER || 'hybrid_agent',
    llm_model: process.env.LLM_MODEL || 'gemini-2.5-flash',
    llm_api_key: process.env.LLM_API_KEY || '',
    ollama_url: process.env.OLLAMA_URL || '',
    webhook_type: process.env.WEBHOOK_TYPE || 'none',
    webhook_url: process.env.WEBHOOK_URL || '',
    notify_on_briefing: 'true',
    notify_on_anomaly: 'true'
  };

  const insertSetting = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, String(v));
  }

  // 2. Accounts (Joint, Partner A, Partner B)
  const accounts = [
    { id: 'acc_chk_joint', name: 'Chase Total Checking (Joint)', institution: 'Chase', type: 'cash', subtype: 'checking', balance: 18420.50, owner: 'joint', is_liquid: 1, apy: 0.01 },
    { id: 'acc_hysa_joint', name: 'Wealthfront Joint Cash Reserve', institution: 'Wealthfront', type: 'cash', subtype: 'savings', balance: 54200.00, owner: 'joint', is_liquid: 1, apy: 4.50 },
    { id: 'acc_chk_pa', name: 'Ally Spending Account', institution: 'Ally Bank', type: 'cash', subtype: 'checking', balance: 4150.25, owner: 'partner_a', is_liquid: 1, apy: 0.25 },
    { id: 'acc_chk_pb', name: 'SoFi Checking', institution: 'SoFi', type: 'cash', subtype: 'checking', balance: 3890.00, owner: 'partner_b', is_liquid: 1, apy: 0.50 },
    { id: 'acc_cc_sapphire', name: 'Chase Sapphire Reserve', institution: 'Chase', type: 'credit', subtype: 'credit_card', balance: -3480.40, owner: 'joint', is_liquid: 0, apy: 21.99 },
    { id: 'acc_cc_amex', name: 'Amex Gold (Household Groceries/Dining)', institution: 'American Express', type: 'credit', subtype: 'credit_card', balance: -2190.85, owner: 'joint', is_liquid: 0, apy: 24.99 },
    { id: 'acc_cc_pa', name: 'Capital One Venture X', institution: 'Capital One', type: 'credit', subtype: 'credit_card', balance: -845.20, owner: 'partner_a', is_liquid: 0, apy: 22.49 },
    { id: 'acc_cc_pb', name: 'Apple Card', institution: 'Goldman Sachs', type: 'credit', subtype: 'credit_card', balance: -612.10, owner: 'partner_b', is_liquid: 0, apy: 20.99 },
    { id: 'acc_inv_vanguard', name: 'Vanguard Joint Brokerage (VTI/VXUS)', institution: 'Vanguard', type: 'investment', subtype: 'brokerage', balance: 196400.00, owner: 'joint', is_liquid: 1, apy: 8.20 },
    { id: 'acc_inv_pa_401k', name: 'Empower 401(k) - Partner A', institution: 'Empower', type: 'investment', subtype: 'retirement', balance: 164800.00, owner: 'partner_a', is_liquid: 0, apy: 8.50 },
    { id: 'acc_inv_pb_401k', name: 'Schwab 401(k) & Roth IRA - Partner B', institution: 'Charles Schwab', type: 'investment', subtype: 'retirement', balance: 142300.00, owner: 'partner_b', is_liquid: 0, apy: 8.50 },
    { id: 'acc_loan_mortgage', name: 'Primary Residence Mortgage (3.25%)', institution: 'Rocket Mortgage', type: 'loan', subtype: 'mortgage', balance: -368500.00, owner: 'joint', is_liquid: 0, apy: 3.25 },
    { id: 'acc_loan_auto', name: 'Rivian / Subaru Auto Loan (4.1%)', institution: 'Chase Auto', type: 'loan', subtype: 'auto', balance: -18900.00, owner: 'joint', is_liquid: 0, apy: 4.10 }
  ];

  const insertAccount = db.prepare(`
    INSERT INTO accounts (id, name, institution, type, subtype, balance, owner, is_liquid, apy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of accounts) {
    insertAccount.run(a.id, a.name, a.institution, a.type, a.subtype, a.balance, a.owner, a.is_liquid, a.apy);
  }

  // 3. Categories (with Fixed vs. Discretionary pre-filled & customizable in UI)
  const categories = [
    { id: 'cat_mortgage', name: 'Mortgage & Property Tax', group_name: 'Housing & Fixed Bills', spend_type: 'fixed', monthly_budget: 3150, icon: 'home' },
    { id: 'cat_utilities', name: 'Utilities, Fiber & Power', group_name: 'Housing & Fixed Bills', spend_type: 'fixed', monthly_budget: 440, icon: 'zap' },
    { id: 'cat_insurance', name: 'Home & Auto Insurance', group_name: 'Housing & Fixed Bills', spend_type: 'fixed', monthly_budget: 365, icon: 'shield' },
    { id: 'cat_auto_loan', name: 'Auto Payment & Transit', group_name: 'Transportation', spend_type: 'fixed', monthly_budget: 780, icon: 'car' },
    { id: 'cat_groceries', name: 'Groceries & Household Essentials', group_name: 'Food & Household', spend_type: 'fixed', monthly_budget: 1150, icon: 'shopping-cart' },
    { id: 'cat_childcare_health', name: 'Medical, Fitness & Wellness', group_name: 'Health & Wellness', spend_type: 'fixed', monthly_budget: 340, icon: 'heart' },
    { id: 'cat_dining', name: 'Restaurants, Coffee & Delivery', group_name: 'Food & Lifestyle', spend_type: 'discretionary', monthly_budget: 900, icon: 'utensils' },
    { id: 'cat_shopping', name: 'Shopping, Tech & Home Gear', group_name: 'Lifestyle & Retail', spend_type: 'discretionary', monthly_budget: 850, icon: 'shopping-bag' },
    { id: 'cat_subscriptions', name: 'Subscriptions, Cloud & Streaming', group_name: 'Digital & Media', spend_type: 'discretionary', monthly_budget: 260, icon: 'repeat' },
    { id: 'cat_travel', name: 'Travel & Weekend Getaways', group_name: 'Lifestyle & Experiences', spend_type: 'discretionary', monthly_budget: 750, icon: 'plane' },
    { id: 'cat_entertainment', name: 'Entertainment & Hobbies', group_name: 'Lifestyle & Experiences', spend_type: 'discretionary', monthly_budget: 400, icon: 'film' },
    { id: 'cat_uncategorized', name: 'Uncategorized / Needs Triage', group_name: 'Triage', spend_type: 'discretionary', monthly_budget: 0, icon: 'alert-circle' },
    { id: 'cat_income', name: 'Paychecks & Salary (Net)', group_name: 'Income', spend_type: 'income', monthly_budget: 14800, icon: 'trending-up' }
  ];

  const insertCat = db.prepare(`
    INSERT INTO categories (id, name, group_name, spend_type, monthly_budget, icon)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const c of categories) {
    insertCat.run(c.id, c.name, c.group_name, c.spend_type, c.monthly_budget, c.icon);
  }

  // 4. Recurring Streams (with Price-Creep Detection)
  const recurring = [
    { id: 'rec_1', merchant: 'Rocket Mortgage', category_id: 'cat_mortgage', frequency: 'monthly', current_amount: 3150.00, previous_amount: 3150.00, next_due_date: '2026-12-01', owner: 'joint', price_hike_detected: 0, account_id: 'acc_chk_joint' },
    { id: 'rec_2', merchant: 'Chase Auto Finance', category_id: 'cat_auto_loan', frequency: 'monthly', current_amount: 645.00, previous_amount: 645.00, next_due_date: '2026-11-18', owner: 'joint', price_hike_detected: 0, account_id: 'acc_chk_joint' },
    { id: 'rec_3', merchant: 'YouTube TV', category_id: 'cat_subscriptions', frequency: 'monthly', current_amount: 82.99, previous_amount: 72.99, next_due_date: '2026-11-14', owner: 'joint', price_hike_detected: 1, account_id: 'acc_cc_sapphire' },
    { id: 'rec_4', merchant: 'AT&T Fiber 1Gbps', category_id: 'cat_utilities', frequency: 'monthly', current_amount: 95.00, previous_amount: 80.00, next_due_date: '2026-11-21', owner: 'joint', price_hike_detected: 1, account_id: 'acc_cc_sapphire' },
    { id: 'rec_5', merchant: 'State Farm Mutual Insurance', category_id: 'cat_insurance', frequency: 'monthly', current_amount: 364.50, previous_amount: 332.00, next_due_date: '2026-11-24', owner: 'joint', price_hike_detected: 1, account_id: 'acc_chk_joint' },
    { id: 'rec_6', merchant: 'Equinox / Peloton All-Access', category_id: 'cat_childcare_health', frequency: 'monthly', current_amount: 244.00, previous_amount: 244.00, next_due_date: '2026-11-12', owner: 'partner_a', price_hike_detected: 0, account_id: 'acc_cc_pa' },
    { id: 'rec_7', merchant: 'Anthropic / Claude Pro', category_id: 'cat_subscriptions', frequency: 'monthly', current_amount: 20.00, previous_amount: 20.00, next_due_date: '2026-11-19', owner: 'partner_a', price_hike_detected: 0, account_id: 'acc_cc_pa' },
    { id: 'rec_8', merchant: 'Spotify Duo', category_id: 'cat_subscriptions', frequency: 'monthly', current_amount: 16.99, previous_amount: 14.99, next_due_date: '2026-11-26', owner: 'partner_b', price_hike_detected: 1, account_id: 'acc_cc_pb' },
    { id: 'rec_9', merchant: 'Backblaze B2 (Unraid Offsite Backup)', category_id: 'cat_subscriptions', frequency: 'monthly', current_amount: 18.40, previous_amount: 17.90, next_due_date: '2026-11-28', owner: 'partner_a', price_hike_detected: 0, account_id: 'acc_cc_pa' },
    { id: 'rec_10', merchant: 'Pacific Gas & Electric (PG&E)', category_id: 'cat_utilities', frequency: 'monthly', current_amount: 288.40, previous_amount: 265.10, next_due_date: '2026-11-16', owner: 'joint', price_hike_detected: 0, account_id: 'acc_chk_joint' }
  ];

  const insertRec = db.prepare(`
    INSERT INTO recurring_streams (id, merchant, category_id, frequency, current_amount, previous_amount, next_due_date, owner, price_hike_detected, account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of recurring) {
    insertRec.run(r.id, r.merchant, r.category_id, r.frequency, r.current_amount, r.previous_amount, r.next_due_date, r.owner, r.price_hike_detected, r.account_id);
  }

  // 5. Historical & Current Month Transactions (May 2026 -> Nov 2026 for 6m velocity & burn-down)
  const insertTx = db.prepare(`
    INSERT INTO transactions (id, date, merchant, raw_merchant, amount, category_id, account_id, owner, is_recurring, needs_review, tags, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  let txCounter = 100;

  for (let mIdx = 0; mIdx < months.length; mIdx++) {
    const ym = months[mIdx];
    const seasonalFactor = 1 + (mIdx % 3 - 1) * 0.04;

    // Monthly Income (Joint / Partner A / Partner B)
    insertTx.run(`tx_${txCounter++}`, `${ym}-01`, 'Direct Deposit - TechCorp Payroll', 'ACH CREDIT TECHCORP PAYROLL', -8400, 'cat_income', 'acc_chk_joint', 'partner_a', 1, 0, '["Paycheck"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-15`, 'Direct Deposit - HealthSys Payroll', 'ACH CREDIT HEALTHSYS INC', -6400, 'cat_income', 'acc_chk_joint', 'partner_b', 1, 0, '["Paycheck"]', '');

    // Fixed Baseline
    insertTx.run(`tx_${txCounter++}`, `${ym}-01`, 'Rocket Mortgage', 'ROCKET MORTGAGE ACH PMT', 3150.00, 'cat_mortgage', 'acc_chk_joint', 'joint', 1, 0, '["Fixed","Housing"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-16`, 'Pacific Gas & Electric (PG&E)', 'PGE UTIL BILL', +(265 * seasonalFactor).toFixed(2), 'cat_utilities', 'acc_chk_joint', 'joint', 1, 0, '["Utilities"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-21`, 'AT&T Fiber 1Gbps', 'ATT*BILL PAYMENT', mIdx < 4 ? 80.00 : 95.00, 'cat_utilities', 'acc_cc_sapphire', 'joint', 1, 0, '["Utilities","Internet"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-24`, 'State Farm Mutual Insurance', 'STATE FARM INS', mIdx < 4 ? 332.00 : 364.50, 'cat_insurance', 'acc_chk_joint', 'joint', 1, 0, '["Insurance"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-18`, 'Chase Auto Finance', 'CHASE AUTO PMT', 645.00, 'cat_auto_loan', 'acc_chk_joint', 'joint', 1, 0, '["Auto"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-09`, 'Shell / EVgo Charging', 'EVGO CHARGING', +(118 * seasonalFactor).toFixed(2), 'cat_auto_loan', 'acc_cc_pa', 'partner_a', 0, 0, '[]', '');

    // Groceries
    insertTx.run(`tx_${txCounter++}`, `${ym}-04`, 'Whole Foods Market', 'WHOLEFDS MKT #1042', +(385 * seasonalFactor).toFixed(2), 'cat_groceries', 'acc_cc_amex', 'joint', 0, 0, '["Groceries"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-12`, 'Costco Wholesale', 'COSTCO WHSE #0482', +(420 * seasonalFactor).toFixed(2), 'cat_groceries', 'acc_cc_sapphire', 'joint', 0, 0, '["Bulk"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-22`, 'Trader Joe\'s', 'TRADER JOES #119', +(295 * seasonalFactor).toFixed(2), 'cat_groceries', 'acc_cc_amex', 'joint', 0, 0, '["Groceries"]', '');

    // Wellness
    insertTx.run(`tx_${txCounter++}`, `${ym}-12`, 'Equinox / Peloton All-Access', 'EQUINOX HOLDINGS', 244.00, 'cat_childcare_health', 'acc_cc_pa', 'partner_a', 1, 0, '["Fitness"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-19`, 'One Medical / Walgreens', 'WALGREENS #4912', +(78 * seasonalFactor).toFixed(2), 'cat_childcare_health', 'acc_cc_pb', 'partner_b', 0, 0, '["HSA-Eligible"]', '');

    // Discretionary: Dining (Notice October & November spike!)
    const diningSpike = mIdx === 5 ? 1.38 : 1.0;
    insertTx.run(`tx_${txCounter++}`, `${ym}-06`, 'DoorDash', 'DOORDASH*DASHPASS', +(240 * diningSpike).toFixed(2), 'cat_dining', 'acc_cc_amex', 'joint', 0, 0, '["Delivery"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-14`, 'Osteria Mozza', 'SQ *OSTERIA MOZZA', +(285 * diningSpike).toFixed(2), 'cat_dining', 'acc_cc_amex', 'joint', 0, 0, '["Date Night"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-20`, 'Blue Bottle Coffee', 'SQ *BLUE BOTTLE', +(86 * diningSpike).toFixed(2), 'cat_dining', 'acc_cc_pa', 'partner_a', 0, 0, '["Coffee"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-25`, 'Sweetgreen & Local Lunches', 'SWEETGREEN #44', +(215 * diningSpike).toFixed(2), 'cat_dining', 'acc_cc_pb', 'partner_b', 0, 0, '[]', '');

    // Discretionary: Shopping
    const shoppingSpike = mIdx === 5 ? 1.28 : 1.0;
    insertTx.run(`tx_${txCounter++}`, `${ym}-08`, 'Amazon Marketplace', 'AMZN MKTP US*8K29L', +(410 * shoppingSpike).toFixed(2), 'cat_shopping', 'acc_cc_sapphire', 'joint', 0, 0, '[]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-17`, 'Apple / B&H Photo Hardware', 'APPLE.COM/BILL', +(265 * shoppingSpike).toFixed(2), 'cat_shopping', 'acc_cc_pa', 'partner_a', 0, 0, '["Homelab"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-23`, 'Nordstrom / Lululemon', 'LULULEMON ATHLETICA', +(195 * shoppingSpike).toFixed(2), 'cat_shopping', 'acc_cc_pb', 'partner_b', 0, 0, '[]', '');

    // Subscriptions
    insertTx.run(`tx_${txCounter++}`, `${ym}-14`, 'YouTube TV', 'GOOGLE *YOUTUBETV', mIdx < 4 ? 72.99 : 82.99, 'cat_subscriptions', 'acc_cc_sapphire', 'joint', 1, 0, '["Streaming"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-19`, 'Anthropic / Claude Pro', 'ANTHROPIC.COM', 20.00, 'cat_subscriptions', 'acc_cc_pa', 'partner_a', 1, 0, '["AI"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-26`, 'Spotify Duo', 'SPOTIFY USA', mIdx < 4 ? 14.99 : 16.99, 'cat_subscriptions', 'acc_cc_pb', 'partner_b', 1, 0, '["Music"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-28`, 'Backblaze B2 (Unraid Offsite Backup)', 'BACKBLAZE INC', 18.40, 'cat_subscriptions', 'acc_cc_pa', 'partner_a', 1, 0, '["Unraid"]', '');

    // Travel & Entertainment
    insertTx.run(`tx_${txCounter++}`, `${ym}-11`, 'Alaska Airlines / Airbnb', 'ALASKA AIR 02749', +(560 * seasonalFactor).toFixed(2), 'cat_travel', 'acc_cc_sapphire', 'joint', 0, 0, '["Travel"]', '');
    insertTx.run(`tx_${txCounter++}`, `${ym}-27`, 'Alamo Drafthouse & Live Nation', 'ALAMO DRAFTHOUSE', +(285 * seasonalFactor).toFixed(2), 'cat_entertainment', 'acc_cc_sapphire', 'joint', 0, 0, '["Entertainment"]', '');
  }

  // Current Month (November 2026 - through Nov 7, plus a full rich dataset for current month pacing & triage)
  const currentMonthTx = [
    { id: 'tx_nov_01', date: '2026-11-01', merchant: 'Direct Deposit - TechCorp Payroll', raw_merchant: 'ACH CREDIT TECHCORP PAYROLL', amount: -8400.00, category_id: 'cat_income', account_id: 'acc_chk_joint', owner: 'partner_a', is_recurring: 1, needs_review: 0, tags: '["Paycheck"]', notes: 'First November paycheck' },
    { id: 'tx_nov_02', date: '2026-11-01', merchant: 'Rocket Mortgage', raw_merchant: 'ROCKET MORTGAGE ACH PMT', amount: 3150.00, category_id: 'cat_mortgage', account_id: 'acc_chk_joint', owner: 'joint', is_recurring: 1, needs_review: 0, tags: '["Fixed","Housing"]', notes: 'Monthly principal, interest & escrow' },
    { id: 'tx_nov_03', date: '2026-11-02', merchant: 'Whole Foods Market', raw_merchant: 'WHOLEFDS MKT #1042', amount: 312.45, category_id: 'cat_groceries', account_id: 'acc_cc_amex', owner: 'joint', is_recurring: 0, needs_review: 0, tags: '["Groceries"]', notes: 'Weekly grocery run' },
    { id: 'tx_nov_04', date: '2026-11-03', merchant: 'AMZN Mktp US*9X41K2', raw_merchant: 'AMZN MKTP US*9X41K2 SEATTLE WA', amount: 289.99, category_id: 'cat_uncategorized', account_id: 'acc_cc_sapphire', owner: 'partner_a', is_recurring: 0, needs_review: 1, tags: '[]', notes: 'WD Red Plus 14TB NAS drive for Unraid parity' },
    { id: 'tx_nov_05', date: '2026-11-04', merchant: 'DoorDash', raw_merchant: 'DD *DOORDASH THAI KITC', amount: 94.80, category_id: 'cat_dining', account_id: 'acc_cc_amex', owner: 'joint', is_recurring: 0, needs_review: 0, tags: '["Delivery"]', notes: '' },
    { id: 'tx_nov_06', date: '2026-11-04', merchant: 'DoorDash', raw_merchant: 'DD *DOORDASH THAI KITC', amount: 94.80, category_id: 'cat_dining', account_id: 'acc_cc_amex', owner: 'joint', is_recurring: 0, needs_review: 1, tags: '["Suspected Duplicate"]', notes: 'Identical amount & merchant posted same day' },
    { id: 'tx_nov_07', date: '2026-11-05', merchant: 'SQ *KISO JAPANESE REST', raw_merchant: 'SQ *KISO JAPANESE REST SAN FRANCISCO', amount: 342.00, category_id: 'cat_dining', account_id: 'acc_cc_amex', owner: 'joint', is_recurring: 0, needs_review: 1, tags: '[]', notes: 'Anniversary dinner' },
    { id: 'tx_nov_08', date: '2026-11-05', merchant: 'TST* TARTINE BAKERY #04', raw_merchant: 'TST* TARTINE BAKERY #04', amount: 48.50, category_id: 'cat_uncategorized', account_id: 'acc_cc_pb', owner: 'partner_b', is_recurring: 0, needs_review: 1, tags: '[]', notes: '' },
    { id: 'tx_nov_09', date: '2026-11-06', merchant: 'Costco Wholesale', raw_merchant: 'COSTCO WHSE #0482', amount: 468.20, category_id: 'cat_groceries', account_id: 'acc_cc_sapphire', owner: 'joint', is_recurring: 0, needs_review: 0, tags: '["Bulk"]', notes: '' },
    { id: 'tx_nov_10', date: '2026-11-06', merchant: 'APPLE.COM/BILL 866-712-7753', raw_merchant: 'APPLE.COM/BILL 866-712-7753 CA', amount: 149.00, category_id: 'cat_uncategorized', account_id: 'acc_cc_pb', owner: 'partner_b', is_recurring: 0, needs_review: 1, tags: '[]', notes: 'Annual family app subscription or AppleCare' },
    { id: 'tx_nov_11', date: '2026-11-07', merchant: 'Delta Air Lines', raw_merchant: 'DELTA AIR 0062381941', amount: 618.40, category_id: 'cat_travel', account_id: 'acc_cc_sapphire', owner: 'joint', is_recurring: 0, needs_review: 0, tags: '["Holiday Flights"]', notes: 'Thanksgiving flights' }
  ];

  for (const t of currentMonthTx) {
    insertTx.run(t.id, t.date, t.merchant, t.raw_merchant, t.amount, t.category_id, t.account_id, t.owner, t.is_recurring, t.needs_review, t.tags, t.notes);
  }

  // 6. Seed Stage & Approve Triage Queue
  const triageItems = [
    {
      id: 'tri_1',
      transaction_id: 'tx_nov_04',
      issue_type: 'uncategorized',
      proposed_action: JSON.stringify({
        category_id: 'cat_shopping',
        category_name: 'Shopping, Tech & Home Gear',
        merchant: 'Amazon Marketplace',
        tags: ['Homelab', 'Unraid'],
        notes: 'WD Red Plus 14TB NAS drive for Unraid parity',
        mark_reviewed: true
      }),
      before_snapshot: JSON.stringify({
        category_id: 'cat_uncategorized',
        category_name: 'Uncategorized / Needs Triage',
        merchant: 'AMZN Mktp US*9X41K2',
        tags: [],
        notes: 'WD Red Plus 14TB NAS drive for Unraid parity',
        needs_review: 1
      }),
      diff_summary: 'Category: Uncategorized → Shopping, Tech & Home Gear • Merchant: AMZN Mktp US*9X41K2 → Amazon Marketplace • Add tags: #Homelab, #Unraid',
      reason: 'Note mentions "WD Red Plus 14TB NAS drive for Unraid parity" and matches 6 historical hardware orders on Amazon.',
      confidence: 0.97,
      status: 'staged'
    },
    {
      id: 'tri_2',
      transaction_id: 'tx_nov_08',
      issue_type: 'messy_merchant',
      proposed_action: JSON.stringify({
        category_id: 'cat_dining',
        category_name: 'Restaurants, Coffee & Delivery',
        merchant: 'Tartine Bakery',
        tags: ['Coffee & Bakery'],
        notes: 'Cleaned Toast POS prefix & categorized under Dining',
        mark_reviewed: true
      }),
      before_snapshot: JSON.stringify({
        category_id: 'cat_uncategorized',
        category_name: 'Uncategorized / Needs Triage',
        merchant: 'TST* TARTINE BAKERY #04',
        tags: [],
        notes: '',
        needs_review: 1
      }),
      diff_summary: 'Category: Uncategorized → Restaurants, Coffee & Delivery • Merchant: TST* TARTINE BAKERY #04 → Tartine Bakery',
      reason: 'Toast POS prefix ("TST*") detected; merchant is a bakery/cafe matching your Food & Lifestyle group.',
      confidence: 0.95,
      status: 'staged'
    },
    {
      id: 'tri_3',
      transaction_id: 'tx_nov_06',
      issue_type: 'duplicate_suspect',
      proposed_action: JSON.stringify({
        category_id: 'cat_dining',
        category_name: 'Restaurants, Coffee & Delivery',
        merchant: 'DoorDash',
        tags: ['Dispute / Duplicate Check'],
        notes: 'Flagged for refund verification: identical $94.80 charge posted twice on 2026-11-04',
        mark_reviewed: true
      }),
      before_snapshot: JSON.stringify({
        category_id: 'cat_dining',
        category_name: 'Restaurants, Coffee & Delivery',
        merchant: 'DoorDash',
        tags: ['Suspected Duplicate'],
        notes: 'Identical amount & merchant posted same day',
        needs_review: 1
      }),
      diff_summary: 'Tag: #Suspected Duplicate → #Dispute / Duplicate Check • Append refund verification note',
      reason: 'Two identical $94.80 charges at "DD *DOORDASH THAI KITC" on Nov 4, 2026 on Amex Gold.',
      confidence: 0.94,
      status: 'staged'
    },
    {
      id: 'tri_4',
      transaction_id: 'tx_nov_07',
      issue_type: 'messy_merchant',
      proposed_action: JSON.stringify({
        category_id: 'cat_dining',
        category_name: 'Restaurants, Coffee & Delivery',
        merchant: 'Kiso Japanese Restaurant',
        tags: ['Date Night'],
        notes: 'Anniversary dinner',
        mark_reviewed: true
      }),
      before_snapshot: JSON.stringify({
        category_id: 'cat_dining',
        category_name: 'Restaurants, Coffee & Delivery',
        merchant: 'SQ *KISO JAPANESE REST',
        tags: [],
        notes: 'Anniversary dinner',
        needs_review: 1
      }),
      diff_summary: 'Merchant: SQ *KISO JAPANESE REST → Kiso Japanese Restaurant • Add tag: #Date Night • Mark Reviewed',
      reason: 'Square POS prefix ("SQ *") and truncated merchant name normalized; tagged #Date Night based on $342 dinner ticket.',
      confidence: 0.92,
      status: 'staged'
    },
    {
      id: 'tri_5',
      transaction_id: 'tx_nov_10',
      issue_type: 'uncategorized',
      proposed_action: JSON.stringify({
        category_id: 'cat_subscriptions',
        category_name: 'Subscriptions, Cloud & Streaming',
        merchant: 'Apple Services',
        tags: ['Annual Subscription'],
        notes: 'Annual family app subscription or AppleCare',
        mark_reviewed: true
      }),
      before_snapshot: JSON.stringify({
        category_id: 'cat_uncategorized',
        category_name: 'Uncategorized / Needs Triage',
        merchant: 'APPLE.COM/BILL 866-712-7753',
        tags: [],
        notes: 'Annual family app subscription or AppleCare',
        needs_review: 1
      }),
      diff_summary: 'Category: Uncategorized → Subscriptions, Cloud & Streaming • Merchant: APPLE.COM/BILL... → Apple Services • Add tag: #Annual Subscription',
      reason: 'APPLE.COM/BILL billing descriptor with round $149.00 charge matches annual subscription billing pattern.',
      confidence: 0.89,
      status: 'staged'
    }
  ];

  const insertTriage = db.prepare(`
    INSERT INTO triage_queue (id, transaction_id, issue_type, proposed_action, before_snapshot, diff_summary, reason, confidence, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of triageItems) {
    insertTriage.run(item.id, item.transaction_id, item.issue_type, item.proposed_action, item.before_snapshot, item.diff_summary, item.reason, item.confidence, item.status);
  }

  // 7. Seed Net Worth History (12 months)
  const nwMonths = [
    { m: '2025-12', cash: 62400, inv: 438000, debt: 405200 },
    { m: '2026-01', cash: 64100, inv: 446500, debt: 403800 },
    { m: '2026-02', cash: 65800, inv: 451200, debt: 402300 },
    { m: '2026-03', cash: 67200, inv: 459000, debt: 400900 },
    { m: '2026-04', cash: 69500, inv: 464800, debt: 399400 },
    { m: '2026-05', cash: 71200, inv: 472100, debt: 398100 },
    { m: '2026-06', cash: 73400, inv: 479600, debt: 396700 },
    { m: '2026-07', cash: 75100, inv: 486200, debt: 395400 },
    { m: '2026-08', cash: 76900, inv: 491800, debt: 394800 },
    { m: '2026-09', cash: 78200, inv: 497400, debt: 394900 },
    { m: '2026-10', cash: 79400, inv: 500900, debt: 394600 },
    { m: '2026-11', cash: 80660.75, inv: 503500, debt: 394528.55 }
  ];
  const insertNw = db.prepare(`
    INSERT INTO net_worth_snapshots (id, month, owner, cash_total, investment_total, debt_total, net_worth)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of nwMonths) {
    insertNw.run(`nw_${n.m}_all`, n.m, 'all', n.cash, n.inv, n.debt, +(n.cash + n.inv - n.debt).toFixed(2));
  }

  // 8. Seed Initial Personal CFO Briefing
  const insertBriefing = db.prepare(`
    INSERT INTO cfo_briefings (id, period_label, source, headline, executive_summary, action_items, metrics_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertBriefing.run(
    'brief_2026_11_w1',
    'November 2026 • Week 1 Check-In',
    'hybrid_auto',
    'Savings rate is strong at 31.4%, but $10,280 in idle checking cash is earning 0.01% APY and 4 recurring bills crept up $67.50/mo.',
    'Your fixed baseline burn rate sits at a healthy $6,128/mo (41% of net take-home pay), giving your household 13.2 months of liquid cash runway—or 45.2 months if including your liquid Vanguard brokerage. However, Dining & Delivery accelerated +38% in October ($1,126 vs. your $825 6-month average) and has already hit $580 in the first 7 days of November. Additionally, our recurring radar caught silent price hikes across YouTube TV (+$10/mo), AT&T Fiber (+$15/mo), State Farm (+$32.50/mo), and Spotify Duo (+$2/mo).',
    JSON.stringify([
      {
        priority: 'high',
        category: 'Cash Optimization',
        title: 'Sweep $10,280 from Chase Checking (0.01%) to Wealthfront HYSA (4.50%)',
        impact: '+$462/yr in risk-free interest',
        detail: 'Chase Joint Checking holds $18,420.50, while your upcoming 30-day checking outflows (Rocket Mortgage $3,150 + Chase Auto $645 + State Farm $364.50 + PG&E $288.40 + $3,500 safety buffer) require $7,947.90.'
      },
      {
        priority: 'high',
        category: 'Anomaly & Duplicate Alert',
        title: 'Verify suspected duplicate $94.80 DoorDash charge on Nov 4',
        impact: '$94.80 potential recovery',
        detail: 'Two identical $94.80 charges from "DD *DOORDASH THAI KITC" posted on Amex Gold on Nov 4. Approve the staged triage item to tag and track the refund.'
      },
      {
        priority: 'medium',
        category: 'Subscription Price Creep',
        title: 'Audit 4 recurring bills that quietly increased by $714/yr annualized',
        impact: '$714/yr recurring creep',
        detail: 'AT&T Fiber promotional rate expired ($80 → $95/mo), YouTube TV rose $72.99 → $82.99/mo, and State Farm renewal jumped +9.8%.'
      },
      {
        priority: 'medium',
        category: 'Budget Pacing',
        title: 'November Dining & Delivery is at 64% of monthly budget on Day 7',
        impact: 'Pacing $410 over budget by Nov 30',
        detail: 'Driven by the $342 anniversary dinner at Kiso plus $189.60 in DoorDash orders. Holding discretionary dining under $80/week for the rest of November keeps your 32% savings target intact.'
      }
    ]),
    JSON.stringify({
      monthly_net_income: 14800,
      fixed_burn: 6128,
      discretionary_burn: 4022,
      savings_rate_pct: 31.4,
      liquid_cash_runway_months: 13.2
    })
  );

  // 9. Seed Sync Log
  db.prepare(`
    INSERT INTO mcp_sync_log (sync_type, status, mcp_calls_used, records_synced, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'scheduled_daily',
    'success',
    5,
    184,
    'Synced 13 accounts, 13 categories, 10 recurring streams, and 148 transactions from https://api.monarch.com/mcp (5/150 weekly MCP quota used)'
  );
}

initSchema();
seedIfNeeded();

module.exports = {
  db,
  DB_PATH,
  DATA_DIR
};
