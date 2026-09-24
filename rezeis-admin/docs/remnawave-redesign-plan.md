# Remnawave page redesign — retired

> Retired with the patch after 0.9.7.69, which cut Remnawave 2.x support out
> of the panel. The file stays so that old links land somewhere.

This was the implementation plan for the admin «Remnawave» page rebuild
(v0.3.3, 26.05.2026), written against `2get.pro` — a panel then on
**Remnawave 2.7.4**. Its reachability matrix, its «🔮 2.8+» fences and its
fallbacks all described what a 2.7.4 panel answered, and none of that is true
for this project any more. The owner decided on 28.08.2026, and restated on
24.09.2026, to refuse 2.x panels outright:

* every call to a panel that reports a major version below 3 is refused with
  `REZEIS_PANEL_TOO_OLD`; only the version reads go out, because their answer
  is what identifies the panel;
* the `/api/ip-control/*` family the plan was built around exists on no panel
  rezeis serves: 3.x replaced it with `/api/connections/*`, and
  `scripts/smoke-redesign-endpoints.sh` no longer probes it;
* the shape-tolerant readers the plan asked for read the 3.x shapes only.

What the page does today is described by the code and its specs, not by a
plan:

* the server routes: `src/modules/remnawave/controllers/admin-remnawave.controller.ts`;
* the readers: `src/modules/remnawave/services/`;
* the screens: `web/src/features/remnawave/`.

The panel releases rezeis is tested against are listed in the contract table
in `README.md` («Remnawave compatibility»). What was cut, and what deliberately
stays, is in `docs/remnawave-2x-removal-inventory.md`.
