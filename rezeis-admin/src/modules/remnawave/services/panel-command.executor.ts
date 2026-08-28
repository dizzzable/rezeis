import { Logger } from '@nestjs/common';

import {
  isPanelMethod,
  resolveCommandUrl,
  type PanelCommand,
  type PanelMethod,
} from './panel-command.contract';

/**
 * PanelCommandExecutor
 * ════════════════════
 * One way to call the Remnawave panel, driven by the vendor's own command
 * definitions instead of by hand-written literals.
 *
 * It replaces three near-identical helpers (`strictHttp`, `requestJson`,
 * `requestJsonWithBody`), a 162-line table of hand-copied route strings, a set
 * of hand-written response interfaces and a hand-maintained list of error
 * codes. Each of those was a copy of something the vendor already publishes,
 * and each could drift from it without a word.
 *
 * ── The asymmetry that matters ──────────────────────────────────────────────
 * Requests are validated STRICTLY and responses LENIENTLY, and the difference
 * is not timidity — it is who owns the bytes.
 *
 * A request body is OURS. If it fails the contract's schema, we built it
 * wrong, and finding that out here is strictly better than finding it out as a
 * `400` from the panel: the message names the field, no network round-trip is
 * spent, and the sync layer never sees a rejection it would file as terminal.
 * Two live defects fall out of this the moment it is switched on — a `PATCH`
 * body keyed `{ uuid }` and an HWID delete keyed `{ userUuid }`, neither of
 * which 3.3.2 declares. Both are currently guaranteed `400`s.
 *
 * A response is the PANEL'S, and rejecting one we merely find surprising is
 * how this integration has already taken an outage. `panel-response-decoders.ts`
 * records it: a vendor schema was executed against a live panel, one field had
 * been renamed between eras, and `getExternalSquadOptions()` threw
 * `ServiceUnavailableException` on EVERY panel with at least one external
 * squad. So a response that fails its schema is logged as drift and handed
 * back anyway. The contract is pinned to one panel minor (3.4.2 ↔ panel 3.3.x)
 * while the fleet runs several, and a required field added in a later minor —
 * `integrationUuids` on nodes, `mapper` on hosts — must not take a feature
 * down on an older one.
 *
 * "Lenient" is not "silent": every drift is logged with the command's own
 * description, and the caller still receives typed data it can null-check.
 */
export class PanelCommandExecutor {
  private readonly logger = new Logger(PanelCommandExecutor.name);

  public constructor(
    private readonly transport: PanelTransport,
    /**
     * Reports drift so a caller can raise it as a system event. Optional: the
     * executor must stay usable from a spec with no event bus, and a missing
     * reporter degrades to the log line rather than to a crash.
     */
    private readonly onDrift?: (report: PanelDriftReport) => void,
  ) {}

  /**
   * Issue one command. Never guesses: the verb, the path and both schemas all
   * come from `command`.
   */
  public async call<TResult = unknown>(
    command: PanelCommand,
    input: PanelCommandInput = {},
  ): Promise<PanelCommandOutcome<TResult>> {
    const method = this.readMethod(command);
    const url = resolveCommandUrl(command, input.pathParts ?? []);

    if (input.body !== undefined && command.RequestBodySchema !== undefined) {
      const parsed = command.RequestBodySchema.safeParse(input.body);
      if (!parsed.success) {
        // OUR bug, not the panel's. Refuse before the request rather than
        // spend a round-trip earning a 400 the sync layer files as terminal.
        return {
          kind: 'invalid-request',
          detail: describeIssues(parsed.error),
          command: describeCommand(command, method, url),
        };
      }
    }

    const response = await this.transport.send({
      method,
      url,
      body: input.body,
      query: input.query,
    });

    if (response.kind !== 'ok') return response;

    if (command.ResponseSchema === undefined) {
      return { kind: 'ok', data: response.data as TResult, drifted: false };
    }
    const parsed = command.ResponseSchema.safeParse(response.data);
    if (parsed.success) {
      return { kind: 'ok', data: parsed.data as TResult, drifted: false };
    }

    // Drift, not failure. See the asymmetry note above.
    const detail = describeIssues(parsed.error);
    this.logger.warn(
      `Remnawave ${method.toUpperCase()} ${url} answered a shape the pinned contract ` +
        `does not declare (${detail}); using it anyway`,
    );
    this.onDrift?.({ method, url, detail, description: command.endpointDetails.METHOD_DESCRIPTION });
    return { kind: 'ok', data: response.data as TResult, drifted: true };
  }

  /**
   * The verb, read from the command rather than passed in.
   *
   * A command whose method this does not recognise is a contract we are
   * reading wrong — an upgrade that changed the field, or a command shape that
   * is not a plain endpoint. Failing loudly here beats defaulting to `get` and
   * silently turning a write into a read.
   */
  private readMethod(command: PanelCommand): PanelMethod {
    const raw = command.endpointDetails.REQUEST_METHOD;
    const normalised = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!isPanelMethod(normalised)) {
      throw new Error(
        `Contract command declares an unusable REQUEST_METHOD ${JSON.stringify(raw)} — ` +
          'the pinned @remnawave/backend-contract is not the shape this executor expects',
      );
    }
    return normalised;
  }
}

/** What one call needs beyond the command itself. */
export interface PanelCommandInput {
  /** Path parameters, in the order the command's url builder takes them. */
  readonly pathParts?: readonly string[];
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
}

export type PanelCommandOutcome<TResult> =
  | { readonly kind: 'ok'; readonly data: TResult; readonly drifted: boolean }
  /** We built a body the contract refuses. Never sent. */
  | { readonly kind: 'invalid-request'; readonly detail: string; readonly command: string }
  | PanelTransportFailure;

/** Everything the executor needs from the network layer, and nothing more. */
export interface PanelTransport {
  send(input: {
    readonly method: PanelMethod;
    readonly url: string;
    readonly body?: unknown;
    readonly query?: Readonly<Record<string, string | number | undefined>>;
  }): Promise<PanelTransportResult>;
}

export type PanelTransportResult =
  | { readonly kind: 'ok'; readonly data: unknown }
  | PanelTransportFailure;

export type PanelTransportFailure =
  /** The panel answered, and refused. `code` is the contract's `A0xx` when present. */
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string | null;
      readonly detail: string | null;
      readonly retryAfterMs: number | null;
    }
  /** Nothing was heard back: DNS, refused connection, reset, timeout. */
  | { readonly kind: 'network'; readonly detail: string }
  /** No base URL or no token. A setting, not a fault. */
  | { readonly kind: 'unconfigured' };

export interface PanelDriftReport {
  readonly method: PanelMethod;
  readonly url: string;
  readonly detail: string;
  readonly description: string | undefined;
}

/** A short, safe rendering of a zod failure. Never includes the parsed value. */
function describeIssues(error: { readonly issues?: ReadonlyArray<unknown> }): string {
  const issues = Array.isArray(error.issues) ? error.issues : [];
  const rendered = issues.slice(0, 5).map((issue) => {
    const record = issue as { path?: unknown; message?: unknown };
    const path = Array.isArray(record.path) && record.path.length > 0 ? record.path.join('.') : '(root)';
    // The MESSAGE only. A zod issue can carry `received`, which for a request
    // is our own payload — on this integration that includes customer emails
    // and telegram ids, and this string goes to the log.
    const message = typeof record.message === 'string' ? record.message : 'invalid';
    return `${path}: ${message}`;
  });
  const suffix = issues.length > rendered.length ? ` (+${issues.length - rendered.length} more)` : '';
  return rendered.length === 0 ? 'no detail' : `${rendered.join('; ')}${suffix}`;
}

function describeCommand(command: PanelCommand, method: PanelMethod, url: string): string {
  const description = command.endpointDetails.METHOD_DESCRIPTION;
  return description === undefined
    ? `${method.toUpperCase()} ${url}`
    : `${method.toUpperCase()} ${url} (${description})`;
}
