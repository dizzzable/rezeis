---
description: Refresh Rezeis project status, progress docs, and next milestone from the current repo state
agent: rezeis-planner
---
Refresh the Rezeis project status from the current repository state.

Required workflow:
- Read `docs/architecture/service-boundaries.md`, `ruid/SPEC.md`, and all files under `docs/progress/` first.
- Inspect the relevant current code/config/tests before making any planning claim.
- Update these docs so they match the repo as it exists now:
  - `docs/progress/current-status.md`
  - `docs/progress/next-milestone.md`
  - `docs/progress/decision-log.md`
- Keep the status grounded in actual file paths, endpoints, routes, and compose/env configuration.
- Propose the next milestone after the current shipped slice and break it into concrete tasks/files.
- Record open architectural risks without redesigning the product.

Return a concise status summary after updating the docs.
