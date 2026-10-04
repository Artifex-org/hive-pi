---
name: app-analytics-dashboard
description: Default method for any analysis request about business data that lives in one of our apps (pyERP/Tessera for WSZ sales, pricing, inventory, production, tasks; pyIMMO for properties, rent, vacancy, loans, construction; kontor for personal wealth, banking, cash flow). The deliverable is a persisted dashboard in the owning app, created over that app's MCP (find → preview → create/update), returned as a link with a short summary and the caveats — not numbers pasted into chat. Covers which app owns the data, metric vs dataset, method notes (price elasticity, speeds/cycle times, forecasts), and the honest fallback when a metric or the dashboard tools are missing. Triggers on "analyse", "analysis", "Analyse", "Auswertung", "dashboard", "price elasticity", "Preiselastizität", "customer groups", "Kundengruppen", "production speed", "task speed", "cycle time", "Durchlaufzeit", "throughput", "forecast", "Prognose", "trend", "vacancy", "Leerstand", "rent roll", "net worth", "cash flow by category", "how fast", "how much did", "compare … over time".
---

# app-analytics-dashboard — analysis requests become app dashboards

When someone asks for an analysis of data one of our apps owns, the answer is a
**dashboard saved in that app**, built from the app's registered metrics,
created through its MCP, and handed back as a link. The app re-runs every widget
under each viewer's own permissions, so the dashboard stays live, shareable and
correct; a chat answer goes stale the moment it is sent.

Answer ad hoc in chat only when (a) no app owns the data, (b) the user asks for
"just the number", or (c) the dashboard tools are not reachable — then say which
of the three applied.

## 1. Pick the owning app

| Data | App | MCP surface |
|---|---|---|
| WSZ sales, pricing, customer groups, inventory, production, tasks, POS, webshop, marketing, finance | **pyERP** (Tessera) | `core_django.agent_access` MCP: shortcuts `analytics_list_metrics`, `analytics_query`, `analytics_find_dashboards`, `analytics_preview_dashboard`, `analytics_create_dashboard`, `analytics_update_dashboard`; otherwise `tessera_search_operations` → `tessera_describe_operation` → `tessera_read` / `tessera_write` |
| Properties, units, leases, rent, vacancy, payments/arrears, loans/debt service, construction, maintenance | **pyIMMO** | assistant MCP `/api/v1/assistant/mcp`: `preview_dashboard` (read), `create_dashboard` (write; needs the user's confirmation) |
| Personal net worth, assets/liabilities by class, banking cash flow, statements | **kontor** | MCP is **read-only by design** (`kontor_cockpit`, `kontor_net_worth`, …). No dashboard writes: answer from the read tools and say a console dashboard needs a reviewed PR |
| ASFAM portfolios, strategies, trading | ASFAM tools/skills | out of scope for this skill |

Several apps involved (e.g. "real-estate cash flow in my net worth") → build in
the app that owns the primary measure and say where the rest came from.

Pick the **company/tenant** explicitly (`tessera_get_context` / `tessera_list_companies`
in pyERP). Never mix companies in one widget unless the user asked for a group view.

## 2. Find before you build

1. `analytics_find_dashboards` with the topic and metric ids. If a matching
   dashboard exists (same question, same company), **update** it instead of
   creating a duplicate; tell the user you updated it.
2. `analytics_list_metrics` (registry). Metrics are curated KPIs and time series
   with tested scope; **datasets** are row-level group-by tables for the
   Explorer. Time series, KPIs, forecasts → metric. "Break this down by any
   column" → dataset widget referencing a saved analysis.
3. If the analysis needs a metric that does not exist, **do not fake it**:
   no client-side arithmetic dressed up as a widget, no hard-coded numbers in a
   note. Either compose it from existing metrics, or propose the new metric as a
   code change (register it in the app's `analytics.py` through the core
   registry, with tests and company scope) and tell the user that is the path.

## 3. Compose the spec (DashboardViewV1)

```json
{"v": 1, "title": "Durchlaufzeiten je Station und Team",
 "description": "Median und P90, letzte 6 Monate",
 "period": {"preset": "last_6_months"},
 "provenance": {"created_by": "agent", "prompt_summary": "<the user's question, ≤500 chars>", "sources": ["production.stationMetrics", "tasks.cycleTime"]},
 "widgets": [
  {"id": "kpi", "kind": "metric", "title": "Median-Durchlaufzeit", "query": {"metric": "tasks.cycleTime"}, "viz": {"type": "kpi"}},
  {"id": "trend", "kind": "forecast", "title": "Durchsatz mit Prognose", "query": {"metric": "tasks.throughputTrend", "granularity": "weekly"}, "horizon": 8, "model": "auto", "viz": {"type": "line"}},
  {"id": "by_station", "kind": "metric", "title": "Je Station", "query": {"metric": "production.stationMetrics"}, "viz": {"type": "table"}},
  {"id": "method", "kind": "note", "title": "Methode", "markdown": "…"}]}
```

Rules:
- ≤ 24 widgets; lead with 1–4 KPIs, then the one chart that answers the
  question, then breakdowns. Fewer, sharper widgets beat a wall of charts.
- Widget queries omit dates: the dashboard `period` supplies them.
- Granularity uses the app's wire values (`daily|weekly|monthly|quarterly|annually`).
- Viz follows the data: time → line/area; ranking → sorted bar or table;
  composition → stacked bar (not pie, except ≤ 4 parts); dense numbers → table.
  The `dataviz` skill and KB `references/dashboard-design.md` own the details.
- **Always add one `note` widget** "Methode/Grenzen": data source, period,
  n per group, model and its backtest error, known confounders. A number
  without its uncertainty misleads.
- Titles and notes in the app's language (German for WSZ, pyIMMO and kontor).
- Dashboards are private by default; share only when asked.

## 4. Preview, then create

1. `analytics_preview_dashboard` with the spec. It validates every widget and
   executes it under your scope without saving anything. Read the per-widget
   summary: empty results, refusals, errors.
2. Fix what preview reports. An **empty or refused widget is information**:
   keep it only if it answers the question honestly (e.g. "elasticity refused:
   insufficient price variation"), otherwise remove it.
3. `analytics_create_dashboard` (or `…_update_dashboard`) with an idempotency
   key. pyIMMO: `create_dashboard` returns a confirmation request — tell the user
   what will be created and let them confirm in the app.
4. Reply with: the link, 3–5 lines of findings (with numbers and their
   uncertainty), the caveats, and what would sharpen the answer.

## 5. Method notes (read before these analyses)

**Price elasticity** (pyERP `pricing.elasticityByCustomerGroup`): log-log
regression of quantity on realised unit price per customer group over time
buckets. It needs *within-group price variation*; WSZ pricelists change rarely,
so expect coded refusals (`insufficient_price_variation`,
`insufficient_observations`). Report refusals as findings, never replace them
with a guess. Confounders to name: promotions, product mix shifts, seasonality
(Christmas), channel changes. Show n, R² and the CI per group; an elasticity
whose CI spans zero is "no measurable effect", not "inelastic".

**Speeds, cycle times, throughput** (`tasks.cycleTime`, `tasks.speedByTeam`,
`production.stationMetrics`, `production.bottleneckAnalysis`): report **median
and P90**, never only the mean (cycle times are right-skewed). Split wait time
from process time where the metric offers it. Little's Law (WIP = throughput ×
cycle time) is a consistency check, not a forecast. Compare teams only on
comparable task types.

**Forecasts** (`forecast` widgets): use `model: "auto"` unless there is a
reason; the backtest error (MAPE/RMSE) is printed with the chart — mention it.
Needs ≥ 2 full seasons for a seasonal model; fewer points → the engine falls
back and says so. Horizons beyond a quarter of the history are speculation.

**pyIMMO / kontor money**: amounts are per company; never sum across
currencies; vacancy as both physical and m²-weighted.

## 6. When the tools are not there

The dashboard operations roll out per app (epic TES-14056). If
`analytics_*_dashboard` / `create_dashboard` is not in the app's tool list,
or the app's MCP is not configured in this harness: answer with the existing
read tools (`analytics_query`, `tessera_read`, pyIMMO read tools, kontor read
tools), state plainly that the dashboard could not be created and why, and do
not invent a link.
