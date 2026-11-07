const { db } = require('./db');

function getSettingsMap() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

function getOwnerClause(owner) {
  if (!owner || owner === 'all') {
    return { sql: '1=1', params: [] };
  }
  return { sql: 'owner = ?', params: [owner] };
}

function computeDashboardData({ owner = 'all', windowMonths = 6 } = {}) {
  const settings = getSettingsMap();
  const ownerFilter = getOwnerClause(owner);

  // 1. Accounts & Net Worth / Liquid Runway
  const accounts = db.prepare(`
    SELECT * FROM accounts
    WHERE ${ownerFilter.sql}
    ORDER BY ABS(balance) DESC
  `).all(...ownerFilter.params);

  let cashTotal = 0;
  let lowYieldCheckingTotal = 0;
  let hysaTotal = 0;
  let liquidInvestmentTotal = 0;
  let retirementInvestmentTotal = 0;
  let creditCardDebtTotal = 0;
  let loanDebtTotal = 0;

  for (const acc of accounts) {
    if (acc.type === 'cash') {
      cashTotal += acc.balance;
      if (acc.apy < 1.0) {
        lowYieldCheckingTotal += acc.balance;
      } else {
        hysaTotal += acc.balance;
      }
    } else if (acc.type === 'investment') {
      if (acc.is_liquid) {
        liquidInvestmentTotal += acc.balance;
      } else {
        retirementInvestmentTotal += acc.balance;
      }
    } else if (acc.type === 'credit') {
      creditCardDebtTotal += Math.abs(acc.balance);
    } else if (acc.type === 'loan') {
      loanDebtTotal += Math.abs(acc.balance);
    }
  }

  const totalAssets = cashTotal + liquidInvestmentTotal + retirementInvestmentTotal;
  const totalDebt = creditCardDebtTotal + loanDebtTotal;
  const currentNetWorth = +(totalAssets - totalDebt).toFixed(2);

  // 2. Categories & Historical Monthly Aggregates
  const categories = db.prepare(`SELECT * FROM categories ORDER BY monthly_budget DESC`).all();
  const catMap = new Map(categories.map(c => [c.id, c]));

  // All transactions filtered by owner
  const allTx = db.prepare(`
    SELECT t.*, c.name as category_name, c.group_name, c.spend_type, c.monthly_budget, a.name as account_name
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN accounts a ON t.account_id = a.id
    WHERE ${owner === 'all' ? '1=1' : 't.owner = ?'}
    ORDER BY t.date DESC, t.id DESC
  `).all(...(owner === 'all' ? [] : [owner]));

  // Historical complete months (2026-05 to 2026-10) + current month (2026-11)
  const historicalMonths = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].slice(-Math.max(1, Math.min(6, Number(windowMonths) || 6)));
  const latestCompleteMonth = '2026-10';
  const prevCompleteMonth = '2026-09';
  const currentMonth = '2026-11';

  // Aggregate monthly totals
  const monthlyStats = {};
  for (const m of [...historicalMonths, currentMonth]) {
    monthlyStats[m] = {
      month: m,
      income: 0,
      fixed: 0,
      discretionary: 0,
      total_spend: 0,
      savings: 0,
      byCategory: {}
    };
  }

  const merchantAgg = {};

  for (const tx of allTx) {
    const ym = tx.date.slice(0, 7);
    if (!monthlyStats[ym]) continue;

    if (tx.amount < 0 || tx.spend_type === 'income') {
      monthlyStats[ym].income += Math.abs(tx.amount);
    } else {
      const amt = tx.amount;
      monthlyStats[ym].total_spend += amt;
      if (tx.spend_type === 'fixed') {
        monthlyStats[ym].fixed += amt;
      } else {
        monthlyStats[ym].discretionary += amt;
      }
      monthlyStats[ym].byCategory[tx.category_id] = (monthlyStats[ym].byCategory[tx.category_id] || 0) + amt;

      // Track merchant velocity across window + current month
      if (historicalMonths.includes(ym) || ym === currentMonth) {
        if (!merchantAgg[tx.merchant]) {
          merchantAgg[tx.merchant] = {
            merchant: tx.merchant,
            category_id: tx.category_id,
            category_name: tx.category_name || 'Uncategorized',
            spend_type: tx.spend_type || 'discretionary',
            total_spend: 0,
            tx_count: 0,
            latest_month_spend: 0,
            current_month_spend: 0
          };
        }
        merchantAgg[tx.merchant].total_spend += amt;
        merchantAgg[tx.merchant].tx_count += 1;
        if (ym === latestCompleteMonth) merchantAgg[tx.merchant].latest_month_spend += amt;
        if (ym === currentMonth) merchantAgg[tx.merchant].current_month_spend += amt;
      }
    }
  }

  for (const m of Object.keys(monthlyStats)) {
    const st = monthlyStats[m];
    st.income = +st.income.toFixed(2);
    st.fixed = +st.fixed.toFixed(2);
    st.discretionary = +st.discretionary.toFixed(2);
    st.total_spend = +st.total_spend.toFixed(2);
    st.savings = +(st.income - st.total_spend).toFixed(2);
    st.savings_rate = st.income > 0 ? +((st.savings / st.income) * 100).toFixed(1) : 0;
  }

  // Rolling averages across historicalMonths
  const numHist = historicalMonths.length || 1;
  const avgIncome = +(historicalMonths.reduce((s, m) => s + monthlyStats[m].income, 0) / numHist).toFixed(2);
  const avgFixedBurn = +(historicalMonths.reduce((s, m) => s + monthlyStats[m].fixed, 0) / numHist).toFixed(2);
  const avgDiscretionaryBurn = +(historicalMonths.reduce((s, m) => s + monthlyStats[m].discretionary, 0) / numHist).toFixed(2);
  const avgTotalBurn = +(avgFixedBurn + avgDiscretionaryBurn).toFixed(2);
  const avgSavings = +(avgIncome - avgTotalBurn).toFixed(2);
  const avgSavingsRate = avgIncome > 0 ? +((avgSavings / avgIncome) * 100).toFixed(1) : 0;

  // Category Velocity & Trends
  const expenseCategories = categories.filter(c => c.spend_type !== 'income');
  const categoryVelocity = expenseCategories.map(cat => {
    const rollingTotal = historicalMonths.reduce((s, m) => s + (monthlyStats[m].byCategory[cat.id] || 0), 0);
    const rollingAvg = +(rollingTotal / numHist).toFixed(2);
    const octSpend = +(monthlyStats[latestCompleteMonth]?.byCategory[cat.id] || 0).toFixed(2);
    const sepSpend = +(monthlyStats[prevCompleteMonth]?.byCategory[cat.id] || 0).toFixed(2);
    const novMtdSpend = +(monthlyStats[currentMonth]?.byCategory[cat.id] || 0).toFixed(2);

    const vsRollingPct = rollingAvg > 0 ? +(((octSpend - rollingAvg) / rollingAvg) * 100).toFixed(1) : 0;
    const momPct = sepSpend > 0 ? +(((octSpend - sepSpend) / sepSpend) * 100).toFixed(1) : 0;
    const budgetUtilizationMtdPct = cat.monthly_budget > 0 ? +((novMtdSpend / cat.monthly_budget) * 100).toFixed(1) : 0;

    let velocityStatus = 'steady';
    if (vsRollingPct >= 20 || budgetUtilizationMtdPct >= 55) velocityStatus = 'spiking';
    else if (vsRollingPct <= -10) velocityStatus = 'cooling';

    return {
      id: cat.id,
      name: cat.name,
      group_name: cat.group_name,
      spend_type: cat.spend_type,
      monthly_budget: cat.monthly_budget,
      rolling_avg: rollingAvg,
      latest_full_month: octSpend,
      prev_full_month: sepSpend,
      current_mtd: novMtdSpend,
      vs_rolling_pct: vsRollingPct,
      mom_pct: momPct,
      budget_utilization_mtd_pct: budgetUtilizationMtdPct,
      velocity_status: velocityStatus,
      monthly_series: historicalMonths.map(m => ({
        month: m,
        amount: +(monthlyStats[m].byCategory[cat.id] || 0).toFixed(2)
      }))
    };
  });

  // Top Merchants
  const topMerchants = Object.values(merchantAgg)
    .sort((a, b) => b.total_spend - a.total_spend)
    .slice(0, 12)
    .map(m => ({
      ...m,
      total_spend: +m.total_spend.toFixed(2),
      avg_ticket: +(m.total_spend / m.tx_count).toFixed(2),
      monthly_avg: +(m.total_spend / (numHist + 0.25)).toFixed(2)
    }));

  // 3. Cash Flow Waterfall / Sankey Breakdown (Based on Rolling Monthly Average)
  const waterfallFlow = {
    net_income: avgIncome,
    fixed_baseline: avgFixedBurn,
    discretionary_lifestyle: avgDiscretionaryBurn,
    net_savings_invested: Math.max(0, avgSavings),
    fixed_pct: avgIncome > 0 ? +((avgFixedBurn / avgIncome) * 100).toFixed(1) : 0,
    discretionary_pct: avgIncome > 0 ? +((avgDiscretionaryBurn / avgIncome) * 100).toFixed(1) : 0,
    savings_pct: avgSavingsRate,
    fixed_categories: categoryVelocity.filter(c => c.spend_type === 'fixed' && c.rolling_avg > 0),
    discretionary_categories: categoryVelocity.filter(c => c.spend_type === 'discretionary' && c.rolling_avg > 0)
  };

  // 4. Recurring Streams & Subscription Price-Creep Radar
  const recurringStreams = db.prepare(`
    SELECT r.*, c.name as category_name, c.spend_type, a.name as account_name
    FROM recurring_streams r
    LEFT JOIN categories c ON r.category_id = c.id
    LEFT JOIN accounts a ON r.account_id = a.id
    WHERE ${owner === 'all' ? '1=1' : 'r.owner = ?'}
    ORDER BY r.next_due_date ASC
  `).all(...(owner === 'all' ? [] : [owner]));

  const monthlyRecurringTotal = +recurringStreams.reduce((s, r) => s + r.current_amount, 0).toFixed(2);
  const annualRecurringTotal = +(monthlyRecurringTotal * 12).toFixed(2);
  const priceHikes = recurringStreams
    .filter(r => r.current_amount > r.previous_amount)
    .map(r => ({
      ...r,
      monthly_increase: +(r.current_amount - r.previous_amount).toFixed(2),
      annual_increase: +((r.current_amount - r.previous_amount) * 12).toFixed(2),
      increase_pct: +(((r.current_amount - r.previous_amount) / r.previous_amount) * 100).toFixed(1)
    }));

  // 5. Liquid Runway & Idle Cash Optimizer
  const baselineRunwayMonths = avgFixedBurn > 0 ? +(cashTotal / avgFixedBurn).toFixed(1) : 99;
  const totalBurnRunwayMonths = avgTotalBurn > 0 ? +(cashTotal / avgTotalBurn).toFixed(1) : 99;
  const extendedLiquidRunwayMonths = avgFixedBurn > 0 ? +((cashTotal + liquidInvestmentTotal) / avgFixedBurn).toFixed(1) : 99;

  // Upcoming 30-day checking bills
  const checkingRecurringOutflows = recurringStreams
    .filter(r => r.account_id === 'acc_chk_joint' || r.account_id === 'acc_chk_pa' || r.account_id === 'acc_chk_pb')
    .reduce((s, r) => s + r.current_amount, 0);

  const safetyBuffer = Number(settings.checking_safety_buffer || 3500);
  const targetCheckingKeep = +(checkingRecurringOutflows + safetyBuffer).toFixed(2);
  const idleCashSweepable = Math.max(0, +(lowYieldCheckingTotal - targetCheckingKeep).toFixed(2));
  const hysaTargetApy = Number(settings.hysa_target_apy || 4.50);
  const annualYieldOpportunity = +((idleCashSweepable * (hysaTargetApy - 0.05)) / 100).toFixed(2);

  // 6. Budget Pacing ("Burn-Down" Chart for Current Month November 2026)
  // Current simulated date is Day 7 of 30 (2026-11-07)
  const totalMonthlyBudget = +expenseCategories.reduce((s, c) => s + c.monthly_budget, 0).toFixed(2);
  const fixedMonthlyBudget = +expenseCategories.filter(c => c.spend_type === 'fixed').reduce((s, c) => s + c.monthly_budget, 0).toFixed(2);
  const discretionaryMonthlyBudget = +expenseCategories.filter(c => c.spend_type === 'discretionary').reduce((s, c) => s + c.monthly_budget, 0).toFixed(2);

  const currentDayOfMonth = 7;
  const daysInMonth = 30;
  const novTxs = allTx.filter(t => t.date.startsWith('2026-11') && t.amount > 0 && t.spend_type !== 'income');
  const novMtdTotal = +novTxs.reduce((s, t) => s + t.amount, 0).toFixed(2);
  const novMtdDiscretionary = +novTxs.filter(t => t.spend_type !== 'fixed').reduce((s, t) => s + t.amount, 0).toFixed(2);
  const novMtdFixed = +novTxs.filter(t => t.spend_type === 'fixed').reduce((s, t) => s + t.amount, 0).toFixed(2);

  // Build daily pacing curve (Days 1..30)
  // Note: Fixed mortgage hits Day 1 ($3,150), so we compare discretionary pacing + total pacing smartly
  const dailyBurnSeries = [];
  let cumulativeActual = 0;
  const dailyDiscretionaryRate = novMtdDiscretionary / currentDayOfMonth;

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = `2026-11-${String(d).padStart(2, '0')}`;
    const daySpend = novTxs.filter(t => t.date === dayStr).reduce((s, t) => s + t.amount, 0);
    if (d <= currentDayOfMonth) {
      cumulativeActual += daySpend;
    }
    const idealBudgetLine = +((totalMonthlyBudget / daysInMonth) * d).toFixed(2);
    // Projected curve after day 7 adds remaining scheduled recurring bills + projected discretionary daily rate
    let projectedTotal = null;
    if (d >= currentDayOfMonth) {
      const scheduledAfterDay7 = recurringStreams
        .filter(r => {
          const rDay = Number(r.next_due_date.slice(8, 10));
          return r.next_due_date.startsWith('2026-11') && rDay > currentDayOfMonth && rDay <= d;
        })
        .reduce((s, r) => s + r.current_amount, 0);
      projectedTotal = +(cumulativeActual + scheduledAfterDay7 + dailyDiscretionaryRate * (d - currentDayOfMonth)).toFixed(2);
    }

    dailyBurnSeries.push({
      day: d,
      date: dayStr,
      actual: d <= currentDayOfMonth ? +cumulativeActual.toFixed(2) : null,
      ideal_budget: idealBudgetLine,
      projected: projectedTotal
    });
  }

  const projectedMonthEndSpend = dailyBurnSeries[daysInMonth - 1].projected || novMtdTotal;
  const projectedBudgetVariance = +(projectedMonthEndSpend - totalMonthlyBudget).toFixed(2);

  // 7. Proactive Anomalies & Alerts ("What I should be thinking about")
  const anomalies = [];

  // Duplicate charge check
  const seenCharges = new Map();
  for (const tx of novTxs) {
    const sig = `${tx.date}_${tx.merchant}_${tx.amount}`;
    if (seenCharges.has(sig)) {
      anomalies.push({
        id: `anom_dup_${tx.id}`,
        severity: 'high',
        type: 'duplicate_charge',
        title: `Suspected Duplicate Charge: ${tx.merchant} ($${tx.amount.toFixed(2)})`,
        description: `Two identical $${tx.amount.toFixed(2)} charges posted on ${tx.date} on ${tx.account_name}.`,
        impact: `$${tx.amount.toFixed(2)} potential refund`,
        transaction_id: tx.id
      });
    }
    seenCharges.set(sig, tx.id);
  }

  // Price hikes on recurring bills
  for (const ph of priceHikes) {
    anomalies.push({
      id: `anom_hike_${ph.id}`,
      severity: ph.monthly_increase >= 15 ? 'high' : 'medium',
      type: 'price_creep',
      title: `Recurring Price Hike: ${ph.merchant} (+$${ph.monthly_increase.toFixed(2)}/mo)`,
      description: `Increased from $${ph.previous_amount.toFixed(2)} to $${ph.current_amount.toFixed(2)} (+${ph.increase_pct}%). Next charge on ${ph.next_due_date}.`,
      impact: `+$${ph.annual_increase.toFixed(2)}/yr annualized`
    });
  }

  // Spiking categories
  for (const cv of categoryVelocity) {
    if (cv.vs_rolling_pct >= 25) {
      anomalies.push({
        id: `anom_spike_${cv.id}`,
        severity: 'medium',
        type: 'category_velocity',
        title: `Category Spike: ${cv.name} (+${cv.vs_rolling_pct}% vs. 6m avg)`,
        description: `Last full month reached $${cv.latest_full_month.toFixed(2)} vs. your $${cv.rolling_avg.toFixed(2)} rolling average, and November MTD is already at $${cv.current_mtd.toFixed(2)} (${cv.budget_utilization_mtd_pct}% of budget).`,
        impact: `+$${(cv.latest_full_month - cv.rolling_avg).toFixed(2)}/mo above baseline`
      });
    }
  }

  // Idle cash alert
  if (idleCashSweepable >= 1000) {
    anomalies.unshift({
      id: 'anom_idle_cash',
      severity: 'high',
      type: 'cash_optimization',
      title: `Idle Checking Cash: $${idleCashSweepable.toLocaleString()} earning <0.25% APY`,
      description: `You have $${lowYieldCheckingTotal.toLocaleString()} in checking, while upcoming 30-day checking bills ($${checkingRecurringOutflows.toLocaleString()}) + your $${safetyBuffer.toLocaleString()} safety buffer only require $${targetCheckingKeep.toLocaleString()}.`,
      impact: `+$${annualYieldOpportunity.toFixed(0)}/yr at ${hysaTargetApy}% APY`
    });
  }

  // 8. Stage & Approve Triage Queue + Undo Log
  const triageQueue = db.prepare(`
    SELECT q.*, t.date, t.amount, t.raw_merchant, t.owner, a.name as account_name
    FROM triage_queue q
    LEFT JOIN transactions t ON q.transaction_id = t.id
    LEFT JOIN accounts a ON t.account_id = a.id
    WHERE ${owner === 'all' ? '1=1' : 't.owner = ?'}
    ORDER BY CASE q.status WHEN 'staged' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, q.confidence DESC
  `).all(...(owner === 'all' ? [] : [owner])).map(row => ({
    ...row,
    proposed_action: JSON.parse(row.proposed_action || '{}'),
    before_snapshot: JSON.parse(row.before_snapshot || '{}')
  }));

  const undoLog = db.prepare(`
    SELECT * FROM undo_log
    ORDER BY applied_at DESC
    LIMIT 25
  `).all().map(row => ({
    ...row,
    previous_state: JSON.parse(row.previous_state || '{}'),
    new_state: JSON.parse(row.new_state || '{}')
  }));

  // 9. Briefings & Net Worth History
  const briefings = db.prepare(`
    SELECT * FROM cfo_briefings
    ORDER BY created_at DESC
    LIMIT 10
  `).all().map(b => ({
    ...b,
    action_items: JSON.parse(b.action_items || '[]'),
    metrics_snapshot: JSON.parse(b.metrics_snapshot || '{}')
  }));

  const netWorthHistory = db.prepare(`
    SELECT * FROM net_worth_snapshots
    WHERE owner = 'all'
    ORDER BY month ASC
  `).all();

  const syncLogs = db.prepare(`
    SELECT * FROM mcp_sync_log
    ORDER BY id DESC
    LIMIT 10
  `).all();

  return {
    meta: {
      generated_at: new Date().toISOString(),
      owner_filter: owner,
      window_months: historicalMonths.length,
      partner_a_name: settings.partner_a_name || 'Partner A',
      partner_b_name: settings.partner_b_name || 'Partner B',
      monarch_connection_mode: settings.monarch_connection_mode || 'demo',
      weekly_mcp_calls_used: Number(settings.weekly_mcp_calls_used || 14),
      weekly_mcp_quota_limit: Number(settings.weekly_mcp_quota_limit || 150)
    },
    kpis: {
      current_net_worth: currentNetWorth,
      total_assets: +totalAssets.toFixed(2),
      total_debt: +totalDebt.toFixed(2),
      liquid_cash: +cashTotal.toFixed(2),
      liquid_investments: +liquidInvestmentTotal.toFixed(2),
      avg_monthly_income: avgIncome,
      avg_fixed_burn: avgFixedBurn,
      avg_discretionary_burn: avgDiscretionaryBurn,
      avg_total_burn: avgTotalBurn,
      avg_monthly_savings: avgSavings,
      avg_savings_rate_pct: avgSavingsRate,
      baseline_runway_months: baselineRunwayMonths,
      total_burn_runway_months: totalBurnRunwayMonths,
      extended_liquid_runway_months: extendedLiquidRunwayMonths,
      idle_cash_sweepable: idleCashSweepable,
      annual_yield_opportunity: annualYieldOpportunity
    },
    cash_optimization: {
      low_yield_checking_total: +lowYieldCheckingTotal.toFixed(2),
      hysa_total: +hysaTotal.toFixed(2),
      upcoming_30d_checking_bills: +checkingRecurringOutflows.toFixed(2),
      safety_buffer: safetyBuffer,
      target_checking_keep: targetCheckingKeep,
      idle_cash_sweepable: idleCashSweepable,
      hysa_target_apy: hysaTargetApy,
      annual_yield_opportunity: annualYieldOpportunity
    },
    budget_pacing: {
      month: currentMonth,
      current_day: currentDayOfMonth,
      days_in_month: daysInMonth,
      total_budget: totalMonthlyBudget,
      fixed_budget: fixedMonthlyBudget,
      discretionary_budget: discretionaryMonthlyBudget,
      mtd_total_spend: novMtdTotal,
      mtd_fixed_spend: novMtdFixed,
      mtd_discretionary_spend: novMtdDiscretionary,
      projected_month_end_spend: projectedMonthEndSpend,
      projected_variance: projectedBudgetVariance,
      daily_series: dailyBurnSeries
    },
    waterfall: waterfallFlow,
    monthly_history: historicalMonths.map(m => monthlyStats[m]),
    category_velocity: categoryVelocity,
    top_merchants: topMerchants,
    recurring_radar: {
      monthly_total: monthlyRecurringTotal,
      annual_total: annualRecurringTotal,
      price_hike_count: priceHikes.length,
      price_hikes_annual_impact: +priceHikes.reduce((s, p) => s + p.annual_increase, 0).toFixed(2),
      streams: recurringStreams,
      price_hikes: priceHikes
    },
    anomalies,
    triage_queue: triageQueue,
    undo_log: undoLog,
    briefings,
    net_worth_history: netWorthHistory,
    accounts,
    categories,
    recent_transactions: allTx.slice(0, 45),
    settings: {
      ...settings,
      monarch_oauth_token: settings.monarch_oauth_token ? '••••••••' : '',
      llm_api_key: settings.llm_api_key ? '••••••••' : ''
    },
    sync_logs: syncLogs
  };
}

module.exports = {
  computeDashboardData,
  getSettingsMap
};
