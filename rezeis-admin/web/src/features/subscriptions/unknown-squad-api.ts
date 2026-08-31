/**
 * `GET /admin/plans/unknown-squads` — the wire boundary.
 * ─────────────────────────────────────────────────────
 * Mirrors `UnknownSquadReport` in
 * `src/modules/plans/services/unknown-squad-audit.service.ts`.
 *
 * THE ARRAYS ARE CHECKED, NOT ASSERTED. `api.get<T>()` is a cast and axios
 * verifies nothing; an HTML error page served with HTTP 200 — which
 * `web/nginx.conf` really does produce for an unmatched `/api` path — is a
 * string with a working `.length`, so it walks past every emptiness guard and
 * dies at the first `.map` inside render. `expectArray` is the sanctioned
 * check and is applied to both arrays.
 *
 * FIELDS READ DEFENSIVELY. The SPA and the API ship as separate images, so a
 * panel build can meet a backend that predates any field here. Counters
 * normalise to `null` rather than to `0`: a zero for a number the server never
 * sent is a confident false statement, and on THIS screen a confident false
 * zero reads as "nothing is broken" — the exact thing it exists to disprove.
 */
import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'

export interface UnknownSquadRow {
  readonly subscriptionId: string
  readonly userId: string
  readonly status: string
  readonly planName: string | null
  readonly unknownSquads: readonly string[]
  readonly externalSquadMissing: boolean
}

export interface UnknownSquadReport {
  readonly scanned: number | null
  readonly affected: number | null
  readonly truncated: boolean
  readonly rows: readonly UnknownSquadRow[]
  readonly affectedPlans: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

function readRow(value: unknown): UnknownSquadRow | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.subscriptionId !== 'string') return null
  return {
    subscriptionId: row.subscriptionId,
    userId: typeof row.userId === 'string' ? row.userId : '',
    status: typeof row.status === 'string' ? row.status : '',
    planName: typeof row.planName === 'string' ? row.planName : null,
    unknownSquads: expectArray<unknown>(row.unknownSquads).filter(
      (uuid): uuid is string => typeof uuid === 'string',
    ),
    externalSquadMissing: row.externalSquadMissing === true,
  }
}

export async function fetchUnknownSquads(): Promise<UnknownSquadReport> {
  const { data } = await api.get<unknown>('/admin/plans/unknown-squads')
  const body = (data ?? {}) as Record<string, unknown>
  return {
    scanned: typeof body.scanned === 'number' ? body.scanned : null,
    affected: typeof body.affected === 'number' ? body.affected : null,
    truncated: body.truncated === true,
    rows: expectArray<unknown>(body.rows)
      .map(readRow)
      .filter((row): row is UnknownSquadRow => row !== null),
    affectedPlans: expectArray<unknown>(body.affectedPlans)
      .map((value) => {
        if (value === null || typeof value !== 'object') return null
        const plan = value as Record<string, unknown>
        if (typeof plan.id !== 'string') return null
        return { id: plan.id, name: typeof plan.name === 'string' ? plan.name : plan.id }
      })
      .filter((plan): plan is { id: string; name: string } => plan !== null),
  }
}
