# Remnawave page redesign — implementation plan

> Source-of-truth for the Remnawave admin page rebuild. Every listed
> capability is gated by what `2get.pro` (Remnawave 2.7.4) actually returns
> today — verified by `scripts/smoke-redesign-endpoints.sh`. Anything marked
> "🔮 2.8+" is built behind a graceful-degradation fence and shows the
> standard "unavailable on your Remnawave version" notice on 2.7.x.

---

## Reachability matrix (verified on 2.7.4)

| Endpoint                                          | Status   | Used by                             |
|---------------------------------------------------|----------|-------------------------------------|
| `/api/system/health`                              | ✅ 200    | Health card on Dashboard            |
| `/api/system/stats`                               | ✅ 200    | Existing Overview                   |
| `/api/system/nodes-metrics`                       | 🔮 404    | Realtime per-node card              |
| `/api/system/nodes-statistics`                    | 🔮 404    | Realtime per-node card              |
| `/api/system/recap`                               | 🔮 404    | Bandwidth dashboard                 |
| `/api/system/bandwidth`                           | 🔮 404    | Bandwidth chart                     |
| `/api/nodes`                                      | ✅ 200    | Nodes tab                           |
| `/api/hosts`                                      | ✅ 200    | Hosts tab                           |
| `/api/hosts/reorder` (POST)                       | ✅ contract | DnD reorder                       |
| `/api/internal-squads/`                           | ✅ 200    | Squads tab                          |
| `/api/external-squads/`                           | ✅ 200    | Squads tab                          |
| `/api/internal-squads/<uuid>/accessible-nodes`    | ✅ contract | Squad drill-down                  |
| `/api/config-profiles/`                           | ✅ 200    | Profiles tab                        |
| `/api/config-profiles/inbounds`                   | ✅ 200    | Profile inbound picker              |
| `/api/config-profiles/<uuid>/computed`            | ✅ contract | Compute config preview            |
| `/api/subscription-settings/`                     | ✅ 200    | Subscription panel                  |
| `/api/subscription-templates`                     | ✅ 200    | Templates panel                     |
| `/api/subscription-page-configs`                  | ✅ 200    | Public landing pages                |
| `/api/snippets`                                   | ✅ 200    | Snippet library                     |
| `/api/subscription-request-history`               | ✅ 200    | User → request log                  |
| `/api/subscription-request-history/stats`         | ✅ 200    | Dashboard sub-request stats         |
| `/api/users/resolve` (with query)                 | ✅ 400-with-query | Search by handle/uuid       |
| `/api/users/v2` (with query)                      | ✅ 400-with-query | Search v2                   |
| `/api/users/by-short-uuid/<uuid>`                 | ✅ contract | Drill into user                   |
| `/api/users/<uuid>/accessible-nodes`              | ✅ contract | User drill-down                   |
| `/api/hwid/devices`                               | ✅ 200    | HWID tab                            |
| `/api/hwid/devices/stats`                         | ✅ 200    | HWID dashboard                      |
| `/api/hwid/devices/top-users`                     | ✅ 200    | HWID abuser list                    |
| `/api/hwid/devices/users/<uuid>`                  | ✅ contract | User HWID list                    |
| `/api/ip-control/fetch-ips`                       | 🔮 404    | Live connections (graceful)         |
| `/api/ip-control/fetch-users-ips`                 | 🔮 404    | Per-user IPs (graceful)             |
| `/api/ip-control/drop-connections`                | 🔮 404    | Drop sessions (graceful)            |
| `/api/infra-billing/providers`                    | ✅ 200    | Costs page                          |
| `/api/infra-billing/billing-nodes`                | ❌ 404    | (Costs detail — fall back)          |
| `/api/infra-billing/bill-records`                 | ❌ 404    | (Costs detail — fall back)          |
| `/api/node-plugins`                               | ✅ 200    | Plugins page (RO at first)          |
| `/api/remnawave-settings`                         | 🔒 403    | Mirror RO (token lacks scope)       |
| `/api/keygen/get-pubkey`                          | ✅ contract | Settings → public key             |

`🔮` = exists in newer Remnawave, our code is shape-tolerant and shows a
"unavailable" placeholder on 2.7.4.
`🔒` = the API token used for development lacks the scope; production tokens
may be allowed.

---

## Information architecture

Replaces the current 7-tab flat list. New top-level structure:

```
Remnawave
├── Dashboard      (overview + health + bandwidth + system stats + activity)
├── Live           (connections, geo heatmap, drop)         [graceful on 2.7]
├── Infra
│   ├── Nodes      (list, realtime, drill-down)
│   ├── Hosts      (list, drag-reorder)
│   └── Squads     (internal+external, accessible-nodes)
├── Catalog
│   ├── Profiles   (config-profiles, computed preview)
│   ├── Templates  (subscription-templates)
│   ├── Pages      (subscription-page-configs)
│   └── Snippets   (snippets library)
├── Users          (search, HWID dashboard, top-abusers, sub-history)
├── Costs          (infra-billing — providers + degrade for missing leaves)
└── Settings       (RO mirror of Remnawave settings + node plugins)
```

UX principles:
- Dashboard cards are *compact* (3-col grid by default), not stretched. Only
  one wide chart per page, max.
- Drill-downs open in `Sheet` from the right edge — no page navigation, no
  router transitions.
- Country flags everywhere a `countryCode` shows up. Single component
  (`<NodeFlag code="DE" />`) reused across nodes/hosts/squads/geo/users.
- Subtle motion: rows fade-up on first paint, badges tween between
  online/offline, card numbers tween via `<NumberFlow />`. No bouncy
  springs — we keep it operator-grade.
- Auto-refresh respect: every "list" query has a small icon-only toggle in
  its header (`5s / 30s / off`), default `off` to save the upstream.

---

## Component contract

### Shared atoms (reusable for the whole admin)

| Component                 | Notes                                                                         |
|---------------------------|-------------------------------------------------------------------------------|
| `<NodeFlag code>`         | renders an SVG flag (lucide is glyph-only — we ship `country-flag-icons`).    |
| `<StatTile>`              | compact card 1/3 width with icon, label, value, optional trend, animated num. |
| `<StatusDot status>`      | tiny dot + label: `online \| offline \| disabled \| unknown`.                 |
| `<MetricBar value max>`   | tabular-nums + horizontal bar, used for traffic/RAM/CPU.                      |
| `<RefreshControl>`        | per-card toggle: off/5s/30s + last-updated relative timestamp.                |
| `<DrilldownSheet>`        | wrapper around Radix Sheet, side="right", w-md (lg-screens)/full (mobile).   |
| `<EndpointDegraded>`      | the "unavailable on your Remnawave version" panel with `t()` keys.            |
| `<TabHeader title sub>`   | small title strip with breadcrumb, action slots, refresh control.             |

### Backend additions

New `RemnawaveApiService` methods (all with shape-tolerant parsers in sibling
mappers, never throw on missing fields):

```
getRemnawaveHealth()                  → /api/system/health
getNodesMetrics()                     → /api/system/nodes-metrics              (returns null on 404)
getSubscriptionPageConfigs()          → /api/subscription-page-configs
getSnippets()                         → /api/snippets
getSubscriptionRequestHistoryStats()  → /api/subscription-request-history/stats
getInfraProviders()                   → /api/infra-billing/providers
getNodePlugins()                      → /api/node-plugins
getRemnawaveSettings()                → /api/remnawave-settings                (returns null on 403/404)

resolveUser({ telegramId? username? email? subUuid? })
                                      → /api/users/resolve  POST
getHwidTopUsers()                     → /api/hwid/devices/top-users

reorderHosts(uuids[])                 → POST /api/hosts/reorder
getSquadAccessibleNodes(uuid)         → /api/internal-squads/<uuid>/accessible-nodes
getComputedConfigProfile(uuid)        → /api/config-profiles/<uuid>/computed

# Live (degrades gracefully on 2.7.4 — backend returns null + status flag)
getLiveIps()                          → /api/ip-control/fetch-ips
getLiveUserIps(uuid)                  → /api/ip-control/fetch-users-ips
dropConnections(targets)              → /api/ip-control/drop-connections
```

All new admin-facing controller routes live under `/admin/remnawave/...`.

### Frontend feature folder layout

```
web/src/features/remnawave/
├── remnawave-page.tsx                  router: top-level tabs
├── remnawave-utils.ts                  formatBytes, summarizeNodes, ...
├── remnawave-api.ts                    typed client (per-section getters)
├── remnawave-flags.tsx                 <NodeFlag /> + emoji fallback
├── shared/
│   ├── stat-tile.tsx
│   ├── status-dot.tsx
│   ├── metric-bar.tsx
│   ├── refresh-control.tsx
│   ├── drilldown-sheet.tsx
│   ├── endpoint-degraded.tsx
│   └── tab-header.tsx
├── dashboard/
│   ├── dashboard-tab.tsx
│   ├── dashboard-health-card.tsx
│   ├── dashboard-bandwidth-card.tsx
│   ├── dashboard-recap-card.tsx
│   └── dashboard-activity-feed.tsx
├── live/
│   ├── live-tab.tsx
│   ├── live-connections-table.tsx
│   ├── live-geo-heatmap.tsx
│   └── drop-connections-button.tsx
├── infra/
│   ├── nodes/
│   │   ├── nodes-tab.tsx
│   │   ├── node-row.tsx
│   │   └── node-drilldown-sheet.tsx
│   ├── hosts/
│   │   ├── hosts-tab.tsx
│   │   └── hosts-reorder-list.tsx
│   └── squads/
│       ├── squads-tab.tsx
│       └── squad-drilldown-sheet.tsx
├── catalog/
│   ├── catalog-tab.tsx
│   ├── profiles-section.tsx
│   ├── templates-section.tsx
│   ├── pages-section.tsx
│   └── snippets-section.tsx
├── users/
│   ├── users-tab.tsx
│   ├── user-search-bar.tsx
│   ├── user-drilldown-sheet.tsx
│   ├── hwid-stats-cards.tsx
│   ├── hwid-top-users-table.tsx
│   └── subscription-request-stats.tsx
├── costs/
│   ├── costs-tab.tsx
│   └── providers-table.tsx
└── settings/
    ├── settings-tab.tsx
    ├── settings-mirror.tsx
    └── plugins-section.tsx
```

---

## Implementation order (kept incremental & shippable)

Each step is independently shippable. Build/lint/tests run cleanly between
steps so we never leave the admin in a half-broken state.

1. **Foundation** — `<NodeFlag />`, `<StatTile />`, `<StatusDot />`,
   `<RefreshControl />`, `<DrilldownSheet />`, `<EndpointDegraded />`,
   `<TabHeader />`, plus extending `summarizeNodes` and adding a country
   helper. Wire the `country-flag-icons` package.
2. **Tab skeleton** — replace the flat 7-tab list with the IA above. Each
   new tab placeholder boots in <100ms with a "coming next step" notice
   so we don't break navigation.
3. **Dashboard** — wire health, recap, bandwidth, top stats, recent webhook
   events. Recap/bandwidth still degrade on 2.7.4.
4. **Infra/Nodes** — flag column, status dot, traffic mini-bars, drill-down.
5. **Infra/Hosts** — DnD reorder via `@dnd-kit/sortable` (already in repo),
   call `POST /api/hosts/reorder`.
6. **Infra/Squads** — both lists with counters + accessible-nodes drill-down.
7. **Catalog** — profiles + computed preview, templates RO, pages, snippets.
8. **Users** — search bar + HWID dashboard + top-abusers + sub-request stats.
9. **Costs** — providers list + degradation note for billing-nodes/records
   (404 on 2.7.4).
10. **Settings** — RO mirror with degradation; plugins read-only list.
11. **Live** — connections + drop. Behind a feature gate that hides the tab
    entirely if `/api/ip-control/fetch-ips` returns 404 (so 2.7.4 operators
    don't see a dead tab).
12. **Polish** — motion, animated numbers (`@number-flow/react`), tooltips,
    skeleton tuning, RBAC capabilities for `connections:drop`.

---

## Out-of-scope for this iteration (intentionally)

- Mutations on plugins (we do read-only first; there's no clean ops story
  for "install this plugin" yet).
- Edit-mode for snippets/pages/templates — JSON editor is a separate work
  package because of validation surface.
- Cost CSV export — pencilled in for the next pass.
