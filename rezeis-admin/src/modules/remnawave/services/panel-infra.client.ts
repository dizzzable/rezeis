import {
  DisableNodeCommand,
  EnableNodeCommand,
  GetBandwidthStatsCommand,
  GetConfigProfilesCommand,
  GetExternalSquadsCommand,
  GetHostsCommand,
  GetInfraProvidersCommand,
  GetInternalSquadsCommand,
  GetMetadataCommand,
  GetNodePluginsCommand,
  GetNodesCommand,
  GetRecapCommand,
  GetRemnawaveHealthCommand,
  GetSnippetsCommand,
  GetStatsCommand,
  GetStatsNodesUsersUsageCommand,
  GetSubpageConfigsCommand,
  GetSubscriptionRequestHistoryCommand,
  GetSubscriptionSettingsCommand,
  GetSubscriptionTemplatesCommand,
  ReorderHostsCommand,
  ResetNodeTrafficCommand,
  RestartNodeCommand,
} from '@remnawave/contract-v34';
import type { z } from 'zod';

import type { RemnawaveSquadOptionInterface } from '../interfaces/remnawave-squad-option.interface';
import type { PanelCommand } from './panel-command.contract';
import {
  PanelCommandExecutor,
  type PanelCommandInput,
  type PanelCommandOutcome,
  type PanelDriftReport,
  type PanelReadOutcome,
  type PanelTransport,
} from './panel-command.executor';
import { decodeSquadOptionList, type PanelSquadListKey } from './panel-response-decoders';

/**
 * PanelInfraClient
 * ════════════════
 * The whole-panel and infrastructure half of the Remnawave adapter — system
 * stats, nodes, hosts, squads, the read-only catalog tabs and the panel-wide
 * subscription-request log — expressed as calls on {@link PanelCommandExecutor}
 * with the vendor's own command objects.
 *
 * It carries no routes, no verbs and no hand-written response interfaces. Every
 * path comes off a `*Command.url`, every verb off its `endpointDetails`, and
 * every return type off its `ResponseSchema` via `z.infer`. What that buys is
 * narrow but real: the trailing slashes are a good example. The vendor
 * publishes `/api/nodes/`, `/api/hosts/`, `/api/config-profiles/` and the rest
 * WITH one; the hand-rolled service sent them without. Both work today because
 * of how the panel's router is mounted, and neither of us would learn about it
 * if that stopped being true. Now the question does not arise.
 *
 * TARGET IS PANEL 3.x. There are no version branches here and no legacy
 * fallbacks: `LegacyPanelRefusal` turns a 2.x panel away before a request is
 * built, so a second era-shaped code path below it would be unreachable
 * decoration. The one exception is stated where it lives — see
 * {@link PanelInfraClient.forVersionProbe}.
 *
 * ── Reads unwrap, writes do not ─────────────────────────────────────────────
 * The rule that decides every signature in this file.
 *
 * A READ returns the `response` payload, unwrapped and typed from the contract,
 * inside a {@link PanelReadOutcome}. A WRITE returns only the transport-level
 * {@link PanelActionOutcome}, because success for a write is the 2xx and
 * nothing else. That is not a stylistic split. `POST /api/nodes/{uuid}/actions/
 * restart` answers 202 with an EMPTY body on 3.x, and `ResetNodeTrafficCommand`
 * declares no `ResponseSchema` at all; a client that insisted on unwrapping an
 * envelope there would report a successful restart as a failed one.
 *
 * ── Failure is a value, never an exception ──────────────────────────────────
 * Nothing in here throws and nothing collapses a failure into `null` or `[]`.
 * The methods this replaces did both, and `panel-transport.ts` names the cost
 * in its own comment: a swallowed failure makes a panel outage indistinguishable
 * from "the panel has no data". `panel-response-decoders.ts` names the caller it
 * misleads — `PlansAdminValidators.assertSquadsAreValid` blocks a write when the
 * panel could not be asked, but tells the operator `External squad not found`
 * when it reads `[]`. So the two outcomes keep different shapes all the way up,
 * and the caller decides its own fail-soft policy with the facts in hand.
 */
export class PanelInfraClient {
  public constructor(private readonly executor: PanelCommandExecutor) {}

  /**
   * A client for the version probe, and ONLY for it.
   *
   * `LegacyPanelRefusal` waits on the detected panel major before letting a
   * request out. The probe is what produces that answer, so a probe behind the
   * refusal is a circular wait — the refusal blocks until the probe answers and
   * the probe cannot be sent until the refusal unblocks. `panel-transport.ts`
   * settles this structurally rather than with an allowlist of exempt paths:
   * the probing client is built on the BARE transport, everything else on the
   * wrapper. This factory is that structure, and it is the only place in the
   * codebase allowed to hand a raw `PanelTransport` to this client.
   *
   * Use it with {@link readPanelVersion} and nothing else. Any other call made
   * through a probe-only instance silently escapes the 2.x refusal, which is
   * exactly the fourteen-call-sites-of-400s outcome the refusal exists to
   * prevent.
   */
  public static forVersionProbe(
    transport: PanelTransport,
    onDrift?: (report: PanelDriftReport) => void,
  ): PanelInfraClient {
    return new PanelInfraClient(new PanelCommandExecutor(transport, onDrift));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Panel-wide counters for the admin dashboard.
   *
   * Handed back as the panel sent it. The two shape quirks the old reader
   * normalised — `onlineStats` sitting beside `users` rather than under it, and
   * `nodes.totalBytesLifetime` arriving as a string once it passes
   * `Number.MAX_SAFE_INTEGER` — belong to `normalizeSystemStats`, which is
   * where they still are. A transport client that quietly reshaped the panel's
   * answer would make the normaliser's tests prove something about this file
   * instead of about the panel.
   */
  public async getSystemStats(): Promise<PanelReadOutcome<PanelSystemStats>> {
    return this.readObject<PanelSystemStats>(GetStatsCommand);
  }

  /** Lifetime and month-to-date totals, plus the panel's own version string. */
  public async getSystemRecap(): Promise<PanelReadOutcome<PanelSystemRecap>> {
    return this.readObject<PanelSystemRecap>(GetRecapCommand);
  }

  /** The five bandwidth comparison windows the dashboard charts. */
  public async getBandwidthStats(): Promise<PanelReadOutcome<PanelBandwidthStats>> {
    return this.readObject<PanelBandwidthStats>(GetBandwidthStatsCommand);
  }

  /**
   * The panel's health endpoint.
   *
   * On 3.x this carries `runtimeMetrics` and NOTHING ELSE — no status, no
   * version, no uptime. The old reader defaulted a missing status to `'ok'` and
   * back-filled the version from `/api/system/metadata`, which is still the
   * right composition for the dashboard, but it is composition and it belongs
   * to the caller. Here a 2xx is the whole health signal, which is what it
   * actually is: the panel answered.
   */
  public async getHealth(): Promise<PanelReadOutcome<PanelHealth>> {
    return this.readObject<PanelHealth>(GetRemnawaveHealthCommand);
  }

  /**
   * Build metadata — version, build number, git commit.
   *
   * See {@link readPanelVersion} before using the typed payload from a probe.
   */
  public async getSystemMetadata(): Promise<PanelReadOutcome<PanelMetadata>> {
    return this.readObject<PanelMetadata>(GetMetadataCommand);
  }

  /**
   * The panel's version string, or `null` when we could not tell.
   *
   * THE PROBE, and the one method here that must survive a panel the pinned
   * contract does not describe — because it is what decides which era the panel
   * is. Contract 3.4.2 declares `version`, `build` AND `git` all required on
   * this response; a 2.7.4 panel answers `{ version }` and a build that predates
   * the endpoint answers 404. Neither may stop the probe: the executor's lenient
   * response handling hands the drifted payload back rather than rejecting it,
   * and this reads `version` off the raw shape instead of trusting the type it
   * was cast to. `PanelMetadata` above is the shape of a HEALTHY 3.3.x answer,
   * not a guarantee about the bytes.
   *
   * `null` means "could not tell", never "old". `panel-transport.ts` records why
   * that distinction has to survive this far: a refusal keyed on an unknown
   * version fires exactly when the panel is already struggling, and the sync
   * layer reads "cannot act" as transient, so it retries forever with nobody
   * alerted. Unknown proceeds as 3.x.
   */
  public async readPanelVersion(): Promise<string | null> {
    const outcome = await this.readEnvelope(GetMetadataCommand);
    if (outcome.kind !== 'ok') return null;
    const payload = asObject(outcome.response);
    if (payload === null) return null;
    const version = payload['version'];
    return typeof version === 'string' && version.length > 0 ? version : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  NODES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Every node the panel serves.
   *
   * `GetNodesCommand` declares the payload as a BARE array — there is no
   * `{ total, nodes }` wrapper on 3.x, and the old reader's tolerance for one
   * was era cover that no longer has an era to cover.
   */
  public async getNodes(): Promise<PanelReadOutcome<readonly PanelNode[]>> {
    return this.readArray<PanelNode>(GetNodesCommand);
  }

  /** Brings a node back into rotation. */
  public async enableNode(uuid: string): Promise<PanelActionOutcome> {
    return this.executor.call<unknown>(EnableNodeCommand, { pathParts: [uuid] });
  }

  /** Takes a node out of rotation. */
  public async disableNode(uuid: string): Promise<PanelActionOutcome> {
    return this.executor.call<unknown>(DisableNodeCommand, { pathParts: [uuid] });
  }

  /**
   * Restarts one node's xray core.
   *
   * `forceRestart: true` IS SENT UNCONDITIONALLY, and the contract now says out
   * loud why it has to be: `RestartNodeCommand.RequestBodySchema` declares
   * `forceRestart` as a required boolean with no default. Omitting it used to
   * earn a `400` from the panel, which surfaced to the operator as "Remnawave
   * integration is unavailable" from a perfectly healthy panel — the original
   * live defect. With the schema in front of the request the same mistake now
   * costs nothing: the executor answers `invalid-request` naming the field, and
   * no round-trip is spent.
   *
   * DELIBERATELY NOT GATED on a capability or version check, and the reasoning
   * is carried over unchanged from the method this replaces:
   *   1. version detection collapses every failure into "unknown" and caches
   *      it, so a gate reading "not confirmed ⇒ omit the field" would re-send
   *      the bodyless request during any detection blip and reproduce the exact
   *      `400` it was added to prevent — the flag would be most likely to fail
   *      precisely when it matters;
   *   2. a flag pays for itself only when both branches are needed, and here
   *      one branch is correct everywhere.
   *
   * `true` RATHER THAN `false`, chosen from the caller because the spec gives
   * the field no description on any version. The only caller is an explicit,
   * permissioned, one-node operator action (`POST nodes/:uuid/restart` behind
   * `@RequirePermission('remnawave', 'edit')`, driven by the per-row "Restart"
   * menu item) — no cron restarts nodes. The SPA reports success on any 2xx, so
   * if the non-forced variant is a panel-side no-op the operator is told the
   * node restarted when it did not. `force` is the variant whose meaning cannot
   * be conditional on a heuristic, so it is the one that makes the operator's
   * intent and the toast agree.
   *
   * 3.x answers 202 with an empty body and `RestartNodeCommand` declares no
   * `ResponseSchema`, so there is nothing to unwrap and the 2xx is the result.
   */
  public async restartNode(uuid: string): Promise<PanelActionOutcome> {
    return this.executor.call<unknown>(RestartNodeCommand, {
      pathParts: [uuid],
      body: { forceRestart: true },
    });
  }

  /** Zeroes one node's traffic counter. Declares no response body. */
  public async resetNodeTraffic(uuid: string): Promise<PanelActionOutcome> {
    return this.executor.call<unknown>(ResetNodeTrafficCommand, { pathParts: [uuid] });
  }

  /**
   * Per-user traffic across the given nodes, for the node-traffic-abuse
   * detector.
   *
   * A `POST` that reads nothing and changes nothing — the node list travels in
   * the body because it is a list, and the window in the query.
   *
   * THE WINDOW AND THE LIMIT ARE THE CALLER'S, not this client's, and that is a
   * deliberate move of a decision rather than an omission. `topUsersLimit` sizes
   * the panel's "top N by traffic" cut, and the detector derives its own
   * baseline FROM the rows it gets back: it takes the cohort median and the sum
   * of the list, then flags a user against both. Ask for too few and the light
   * tail is truncated, the median lands near the offender's own magnitude, and
   * a genuine offender is silently dropped — while the smaller sum inflates
   * every share percentage at the same time. A default here would put that
   * sizing somewhere the detector's author never looks. The values in use today
   * (a one-day UTC window, 25 000 rows) and the full reasoning for them live
   * with `NODE_USERS_BANDWIDTH_TOP_LIMIT` and `buildNodeUsersBandwidthPath` in
   * `remnawave-api.service.ts`.
   *
   * An EMPTY `nodeUuids` never leaves the process: the contract declares the
   * array as minimum one, so the executor answers `invalid-request`. The old
   * reader sent it and collected a `400`, which it then reported as `null` —
   * "the panel did not answer" — for a request the panel was right to refuse.
   */
  public async getNodeUsersBandwidth(input: {
    readonly nodeUuids: readonly string[];
    /** Inclusive window start, as the panel spells dates (`YYYY-MM-DD`). */
    readonly start: string;
    /** Inclusive window end. */
    readonly end: string;
    /** How many rows to ask for. See the note above before choosing one. */
    readonly topUsersLimit: number;
  }): Promise<PanelReadOutcome<PanelNodeUsersBandwidth>> {
    const outcome = await this.readObject<PanelNodeUsersBandwidth>(GetStatsNodesUsersUsageCommand, {
      body: { nodesUuids: [...input.nodeUuids] },
      query: { start: input.start, end: input.end, topUsersLimit: input.topUsersLimit },
    });
    if (outcome.kind !== 'ok') return outcome;
    if (!Array.isArray(outcome.data.topUsers)) {
      // "No offenders" and "we could not read the answer" must not wear the
      // same clothes — the detector accuses customers on the strength of this
      // list. The reader this replaces returned `[]` for both, which is the
      // conflation its own comment argued against.
      return unreadable(
        `\`response.topUsers\` is ${describe(outcome.data.topUsers)}, not an array`,
      );
    }
    return outcome;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HOSTS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Every host, as a bare array — same shape story as {@link getNodes}. */
  public async getHosts(): Promise<PanelReadOutcome<readonly PanelHost[]>> {
    return this.readArray<PanelHost>(GetHostsCommand);
  }

  /**
   * Rewrites the top→bottom host order.
   *
   * `viewPosition` is 1-based, matching what the panel serves back. The uuids
   * are checked against the contract's own `uuid` format before anything is
   * sent, so a caller that passes a name or a short id learns it here instead
   * of from a `400`.
   */
  public async reorderHosts(uuids: readonly string[]): Promise<PanelActionOutcome> {
    return this.executor.call<unknown>(ReorderHostsCommand, {
      body: { hosts: uuids.map((uuid, index) => ({ uuid, viewPosition: index + 1 })) },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SQUADS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * `{ uuid, name }` for every internal squad, for the plan squad selectors.
   *
   * Decoded by {@link decodeSquadOptionList}, NEVER by executing a vendor schema
   * for its verdict. Read that module's header before changing anything here:
   * this exact read is the one that took a feature down. The option reader used
   * to `safeParse` the response with the pinned contract of the day, a field had
   * been renamed between panel eras, and the external-squad twin of this method
   * threw `ServiceUnavailableException` on EVERY panel that had at least one
   * external squad — deterministically, while an empty list passed trivially,
   * which is why operators reported it as intermittent.
   *
   * The pinned schema still runs, one layer down, but only for its verdict on
   * DRIFT: the executor logs a response it does not fully accept and hands it
   * back anyway. So a squad row carrying a field this contract has never heard
   * of arrives here intact, and the decoder — which consults nothing beyond
   * `uuid` and `name` — reads it.
   */
  public async getInternalSquadOptions(): Promise<
    PanelReadOutcome<readonly RemnawaveSquadOptionInterface[]>
  > {
    return this.readSquadOptions(GetInternalSquadsCommand, 'internalSquads');
  }

  /** Full-shape internal squads, with the `info` counters the Squads tab shows. */
  public async getInternalSquads(): Promise<PanelReadOutcome<readonly PanelInternalSquad[]>> {
    return this.readKeyedArray<PanelInternalSquad>(GetInternalSquadsCommand, 'internalSquads');
  }

  /**
   * `{ uuid, name }` for every external squad. The read that broke. See
   * {@link getInternalSquadOptions}.
   */
  public async getExternalSquadOptions(): Promise<
    PanelReadOutcome<readonly RemnawaveSquadOptionInterface[]>
  > {
    return this.readSquadOptions(GetExternalSquadsCommand, 'externalSquads');
  }

  /**
   * Full-shape external squads.
   *
   * The element type is what a HEALTHY 3.3.x row looks like, and a drifted
   * response is handed back under the same type — that is the deal the executor
   * makes, and `drifted` on the outcome is how a caller learns of it. Anything
   * mapping these rows must therefore stay field-tolerant rather than trusting
   * the declaration, which is precisely why `mapExternalSquadDetails` survived
   * the rename that killed the option read on the same endpoint.
   */
  public async getExternalSquads(): Promise<PanelReadOutcome<readonly PanelExternalSquad[]>> {
    return this.readKeyedArray<PanelExternalSquad>(GetExternalSquadsCommand, 'externalSquads');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  READ-ONLY CATALOG TABS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Config profiles and their inbounds. */
  public async getConfigProfiles(): Promise<PanelReadOutcome<readonly PanelConfigProfile[]>> {
    return this.readKeyedArray<PanelConfigProfile>(GetConfigProfilesCommand, 'configProfiles');
  }

  /** Reusable snippets referenced by subscription templates. */
  public async getSnippets(): Promise<PanelReadOutcome<readonly PanelSnippet[]>> {
    return this.readKeyedArray<PanelSnippet>(GetSnippetsCommand, 'snippets');
  }

  /** Subscription templates, without their bodies — the list view only. */
  public async getSubscriptionTemplates(): Promise<
    PanelReadOutcome<readonly PanelSubscriptionTemplate[]>
  > {
    return this.readKeyedArray<PanelSubscriptionTemplate>(
      GetSubscriptionTemplatesCommand,
      'templates',
    );
  }

  /**
   * The single panel-wide subscription settings object.
   *
   * Everything the panel publishes is returned. Deciding which fields reach an
   * admin screen — the old reader hid the raw `happAnnounce` / `happRouting`
   * payloads — is a presentation choice, and a transport client that made it
   * would hide the same fields from every future caller with no way to ask.
   */
  public async getSubscriptionSettings(): Promise<PanelReadOutcome<PanelSubscriptionSettings>> {
    return this.readObject<PanelSubscriptionSettings>(GetSubscriptionSettingsCommand);
  }

  /** Landing pages served when a subscription URL is opened in a browser. */
  public async getSubscriptionPageConfigs(): Promise<
    PanelReadOutcome<readonly PanelSubpageConfig[]>
  > {
    return this.readKeyedArray<PanelSubpageConfig>(GetSubpageConfigsCommand, 'configs');
  }

  /** Plugins registered against nodes. */
  public async getNodePlugins(): Promise<PanelReadOutcome<readonly PanelNodePlugin[]>> {
    return this.readKeyedArray<PanelNodePlugin>(GetNodePluginsCommand, 'nodePlugins');
  }

  /**
   * Cost-side providers — the first slice of `infra-billing`. The deeper
   * billing-nodes and bill-records branches are intentionally not wired here;
   * nothing in rezeis reads them yet.
   */
  public async getInfraProviders(): Promise<PanelReadOutcome<readonly PanelInfraProvider[]>> {
    return this.readKeyedArray<PanelInfraProvider>(GetInfraProvidersCommand, 'providers');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SUBSCRIPTION REQUEST LOG
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The whole-panel "who is pulling /sub/xxx" log, newest first.
   *
   * WHOLE-PANEL ONLY, and the omission is the point. The panel exposes two
   * readers and only the per-user one can answer "what did THIS user fetch
   * with": this endpoint takes `start` and `size` and nothing else — no user
   * filter, no time filter. A caller that once passed `userUuid` here was served
   * an unfiltered page of the entire panel's log with no way to tell. Attributed
   * reads go through `GetUserSubscriptionRequestHistoryCommand`, where the id is
   * in the path.
   *
   * `total` is the panel's own count of the ENTIRE log rather than of this page,
   * so a caller that has to window by `requestAt` can at least say how small a
   * slice it looked at — and must treat a page entirely newer than its window as
   * evidence the window was NOT fully covered.
   */
  public async getSubscriptionRequestHistory(
    input: { readonly start?: number; readonly size?: number } = {},
  ): Promise<PanelReadOutcome<PanelSubscriptionRequestHistoryPage>> {
    const outcome = await this.readObject<PanelSubscriptionRequestHistoryPage>(
      GetSubscriptionRequestHistoryCommand,
      { query: { start: input.start, size: input.size } },
    );
    if (outcome.kind !== 'ok') return outcome;
    if (!Array.isArray(outcome.data.records)) {
      // A 2xx whose body is not the documented envelope is a contract
      // violation, NOT an empty log. Reporting it as "no records" would let a
      // panel that changed shape read as a panel where nothing happened — and
      // the caller is a detector that treats a clean log as evidence.
      return unreadable(`\`response.records\` is ${describe(outcome.data.records)}, not an array`);
    }
    return outcome;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERNALS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * One command, with the vendor envelope peeled off and nothing assumed about
   * what was under it.
   *
   * The envelope check is not ceremony. When a response fails its schema the
   * executor hands the RAW payload back — deliberately, so cosmetic drift
   * cannot take a feature down — and a raw payload that is an HTML error page
   * or a proxy's own JSON has no `response` key at all. Reading `.response` off
   * it yields `undefined`, which every guard below would then have to recognise
   * separately. Refusing once, here, is what keeps "unreadable" from arriving
   * downstream disguised as "empty".
   */
  private async readEnvelope(
    command: PanelCommand,
    input?: PanelCommandInput,
  ): Promise<
    | { readonly kind: 'ok'; readonly response: unknown; readonly drifted: boolean }
    | PanelReadFailure
  > {
    const outcome = await this.executor.call<unknown>(command, input);
    if (outcome.kind !== 'ok') return outcome;
    const envelope = asObject(outcome.data);
    if (envelope === null || !('response' in envelope)) {
      return unreadable(`the payload is ${describe(outcome.data)}, carrying no \`response\``);
    }
    return { kind: 'ok', response: envelope['response'], drifted: outcome.drifted };
  }

  /** A read whose payload the contract declares as an object. */
  private async readObject<T>(
    command: PanelCommand,
    input?: PanelCommandInput,
  ): Promise<PanelReadOutcome<T>> {
    const outcome = await this.readEnvelope(command, input);
    if (outcome.kind !== 'ok') return outcome;
    if (asObject(outcome.response) === null) {
      return unreadable(`\`response\` is ${describe(outcome.response)}, not an object`);
    }
    return { kind: 'ok', data: outcome.response as T, drifted: outcome.drifted };
  }

  /** A read whose payload IS the array — `GET /api/nodes/`, `GET /api/hosts/`. */
  private async readArray<T>(command: PanelCommand): Promise<PanelReadOutcome<readonly T[]>> {
    const outcome = await this.readEnvelope(command);
    if (outcome.kind !== 'ok') return outcome;
    if (!Array.isArray(outcome.response)) {
      return unreadable(`\`response\` is ${describe(outcome.response)}, not an array`);
    }
    return { kind: 'ok', data: outcome.response as readonly T[], drifted: outcome.drifted };
  }

  /**
   * A read whose payload wraps the array under a named key alongside `total`.
   *
   * The guard stops at "is the array there". It deliberately does NOT adopt the
   * stricter rule the squad and user-list decoders apply — that an empty list is
   * believed only when the panel also says `total: 0`. That rule exists for
   * callers who act on absence (a plan validator telling an operator a squad
   * does not exist), and generalising it to the catalog tabs would turn a panel
   * that omits one counter into seven empty admin screens.
   */
  private async readKeyedArray<T>(
    command: PanelCommand,
    key: string,
  ): Promise<PanelReadOutcome<readonly T[]>> {
    const outcome = await this.readEnvelope(command);
    if (outcome.kind !== 'ok') return outcome;
    const payload = asObject(outcome.response);
    if (payload === null) {
      return unreadable(`\`response\` is ${describe(outcome.response)}, not an object`);
    }
    const rows = payload[key];
    if (!Array.isArray(rows)) {
      return unreadable(`\`response.${key}\` is ${describe(rows)}, not an array`);
    }
    return { kind: 'ok', data: rows as readonly T[], drifted: outcome.drifted };
  }

  /**
   * Shared tail of both squad option reads.
   *
   * The WHOLE body goes to the decoder rather than an unwrapped payload,
   * because the decoder owns the envelope rules too — including the one that
   * distinguishes an empty list the panel confirmed with `total: 0` from an
   * empty list it did not. Splitting that decision across two files is how it
   * would drift.
   */
  private async readSquadOptions(
    command: PanelCommand,
    listKey: PanelSquadListKey,
  ): Promise<PanelReadOutcome<readonly RemnawaveSquadOptionInterface[]>> {
    const outcome = await this.executor.call<unknown>(command);
    if (outcome.kind !== 'ok') return outcome;
    const decoded = decodeSquadOptionList(outcome.data, listKey);
    if (!decoded.ok) return unreadable(decoded.reason);
    return { kind: 'ok', data: decoded.value, drifted: outcome.drifted };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  OUTCOMES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What a read answers.
 *
 * {@link PanelCommandOutcome} plus one member the executor has no reason to
 * know about: `unreadable` — the panel returned 2xx and a body this client
 * could not find the asked-for data in. That is a THIRD thing, distinct from
 * both "the panel refused" and "the panel answered, and the answer is empty",
 * and it is exactly the distinction `panel-response-decoders.ts` exists to
 * defend. It is a value rather than a throw so that no caller can acquire it by
 * accident.
 */
export type { PanelReadOutcome };

/** Every read outcome except success, so the guards above can return one. */
export type PanelReadFailure = Exclude<PanelReadOutcome<unknown>, { readonly kind: 'ok' }>;

/**
 * What a write answers. Success is the 2xx: `RestartNodeCommand` and
 * `ResetNodeTrafficCommand` declare no response body at all, and 3.x answers a
 * restart with 202 and nothing, so there is no envelope to insist on.
 */
export type PanelActionOutcome = PanelCommandOutcome<unknown>;

// ═════════════════════════════════════════════════════════════════════════════
//  RETURN TYPES, TAKEN FROM THE CONTRACT
// ═════════════════════════════════════════════════════════════════════════════
//
// Every one of these is `z.infer` over a vendor `ResponseSchema`. None is
// hand-written, because a hand-written copy of a published shape agrees with it
// only until someone edits the panel — and the point of paying to ship the
// contract package at runtime is that it stops being possible to disagree
// silently. What they describe is a HEALTHY panel-3.3.x answer; a response the
// pinned schema does not fully accept still arrives under the same type, with
// `drifted: true` on the outcome saying so.

export type PanelSystemStats = z.infer<typeof GetStatsCommand.ResponseSchema>['response'];
export type PanelSystemRecap = z.infer<typeof GetRecapCommand.ResponseSchema>['response'];
export type PanelBandwidthStats = z.infer<
  typeof GetBandwidthStatsCommand.ResponseSchema
>['response'];
export type PanelHealth = z.infer<typeof GetRemnawaveHealthCommand.ResponseSchema>['response'];
export type PanelMetadata = z.infer<typeof GetMetadataCommand.ResponseSchema>['response'];

export type PanelNode = z.infer<typeof GetNodesCommand.ResponseSchema>['response'][number];
export type PanelHost = z.infer<typeof GetHostsCommand.ResponseSchema>['response'][number];
export type PanelNodeUsersBandwidth = z.infer<
  typeof GetStatsNodesUsersUsageCommand.ResponseSchema
>['response'];

export type PanelInternalSquad = z.infer<
  typeof GetInternalSquadsCommand.ResponseSchema
>['response']['internalSquads'][number];
export type PanelExternalSquad = z.infer<
  typeof GetExternalSquadsCommand.ResponseSchema
>['response']['externalSquads'][number];

export type PanelConfigProfile = z.infer<
  typeof GetConfigProfilesCommand.ResponseSchema
>['response']['configProfiles'][number];
export type PanelSnippet = z.infer<
  typeof GetSnippetsCommand.ResponseSchema
>['response']['snippets'][number];
export type PanelSubscriptionTemplate = z.infer<
  typeof GetSubscriptionTemplatesCommand.ResponseSchema
>['response']['templates'][number];
export type PanelSubscriptionSettings = z.infer<
  typeof GetSubscriptionSettingsCommand.ResponseSchema
>['response'];
export type PanelSubpageConfig = z.infer<
  typeof GetSubpageConfigsCommand.ResponseSchema
>['response']['configs'][number];
export type PanelNodePlugin = z.infer<
  typeof GetNodePluginsCommand.ResponseSchema
>['response']['nodePlugins'][number];
export type PanelInfraProvider = z.infer<
  typeof GetInfraProvidersCommand.ResponseSchema
>['response']['providers'][number];

export type PanelSubscriptionRequestHistoryPage = z.infer<
  typeof GetSubscriptionRequestHistoryCommand.ResponseSchema
>['response'];

// ═════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function unreadable(detail: string): { readonly kind: 'unreadable'; readonly detail: string } {
  return { kind: 'unreadable', detail };
}

/**
 * A plain JSON object, or `null` for anything else.
 *
 * Arrays are rejected on purpose, for the reason `panel-response-decoders.ts`
 * gives at length: `typeof [] === 'object'` and every property read off one
 * yields `undefined`, so an array reaching an envelope check would present as
 * "an object whose every field is missing" — the misreading that turns an
 * unreadable payload into a confident empty answer.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Short, log-safe description of an unexpected value. Numbers and booleans
 * print by value because that is usually the whole diagnosis; strings and
 * objects print only their type, because their contents are panel data —
 * usernames, urls, header values — and this text reaches the operator log.
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'absent';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `a ${typeof value}`;
}
