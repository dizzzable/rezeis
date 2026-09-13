import { Logger } from '@nestjs/common';

import {
  describeIssues,
  isPanelMethod,
  resolveCommandUrl,
  type PanelCommand,
  type PanelMethod,
} from './panel-command.contract';

/**
 * PanelCommandExecutor
 * ════════════════════
 * One way to call the Remnawave panel, driven by the hand-owned command table in
 * `panel-commands.ts` instead of by literals scattered across call sites.
 *
 * ── Requests are checked; responses are handed back as the panel sent them ──
 * The asymmetry is about who owns the bytes.
 *
 * A request body is OURS. If it fails its schema we built it wrong, and finding
 * that out here is strictly better than finding it out as a `400` from the
 * panel: the message names the field, no round-trip is spent, and the sync layer
 * never sees a rejection it would file as terminal.
 *
 * A response is the PANEL'S, and this executor no longer runs any schema over
 * one. It used to `safeParse` every answer with a pinned vendor contract,
 * returning the parsed data on success and the raw body, flagged as drift, on a
 * mismatch. That bought two things the callers turned out not to need — `Date`
 * objects and stripped keys — and cost one they could not afford: a contract
 * describes ONE panel release while the fleet runs several, so a field a later
 * release made required flagged every healthy older panel as drift, and the pin
 * could never move. The callers read raw bodies with their own guards; where a
 * caller genuinely depended on the old parse, the client that serves it now does
 * that one thing explicitly (see the consumer notes in `panel-devices.client.ts`
 * and `panel-infra.client.ts`).
 *
 * What never changed: a failure is a value, not an exception, and the transport's
 * `rejected` / `network` / `unconfigured` reach the caller untouched.
 */
export class PanelCommandExecutor {
  private readonly logger = new Logger(PanelCommandExecutor.name);

  public constructor(private readonly transport: PanelTransport) {}

  /**
   * Issue one command. Never guesses: the verb, the path and the body schema all
   * come from `command`.
   */
  public async call<TResult = unknown>(
    command: PanelCommand,
    input: PanelCommandInput = {},
  ): Promise<PanelCommandOutcome<TResult>> {
    const method = this.readMethod(command);
    const url = resolveCommandUrl(command, input.pathParts ?? []);

    let body = input.body;
    if (input.body !== undefined && command.body !== undefined) {
      const parsed = command.body.safeParse(input.body);
      if (!parsed.success) {
        // OUR bug, not the panel's. Refuse before the request rather than
        // spend a round-trip earning a 400 the sync layer files as terminal.
        return {
          kind: 'invalid-request',
          detail: describeIssues(parsed.error),
          command: describeCommand(command, method, url),
        };
      }
      // WHAT WE VALIDATED IS WHAT WE SEND.
      //
      // The PARSED body, not the caller's object — and that is load-bearing, not
      // tidiness. The schema's defaults (`status: ACTIVE`, `trafficLimitStrategy:
      // NO_RESET` on a create), its key order and its `expireAt` transform are
      // part of the bytes the panel has always received;
      // `test/panel-wire-bytes.spec.ts` pins them at every production call site.
      // Validating one value and sending another would also make the validation
      // advisory, which reads as a guarantee and is not one.
      body = parsed.data;
      // Zod strips keys an object schema does not declare, so enforcement can
      // also DELETE something a caller meant to send. The table is the authority
      // on what we send, but a field vanishing between here and the panel must
      // not be silent.
      const dropped = droppedKeys(input.body, parsed.data);
      if (dropped.length > 0) {
        this.logger.warn(
          `Remnawave ${method.toUpperCase()} ${url}: the command table does not declare ` +
            `${dropped.join(', ')}; those field(s) were not sent`,
        );
      }
    }

    const response = await this.transport.send({
      method,
      url,
      body,
      query: input.query,
    });

    if (response.kind !== 'ok') return response;
    // A typed view of the panel's JSON, not a validated one. Every reader below
    // this line guards what it relies on.
    return { kind: 'ok', data: response.data as TResult };
  }

  /**
   * The verb, read from the command rather than passed in.
   *
   * The table types `method`, so this can only fire on a command object built
   * past the compiler. Failing loudly beats defaulting to `get` and silently
   * turning a write into a read.
   */
  private readMethod(command: PanelCommand): PanelMethod {
    const raw: unknown = command.method;
    const normalised = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!isPanelMethod(normalised)) {
      throw new Error(
        `Panel command declares an unusable method ${JSON.stringify(raw)} — ` +
          'the command table is not the shape this executor expects',
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
  | { readonly kind: 'ok'; readonly data: TResult }
  /** We built a request the command table refuses. Never sent. */
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
  /** The panel answered, and refused. `code` is the panel's `A0xx` when present. */
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

function describeCommand(command: PanelCommand, method: PanelMethod, url: string): string {
  return `${method.toUpperCase()} ${url} (${command.description})`;
}

/**
 * Top-level keys the schema removed. Names only — a value here would be the
 * caller's payload, which on this integration carries customer contact
 * details, and this feeds a log line.
 */
function droppedKeys(before: unknown, after: unknown): readonly string[] {
  if (!isPlainRecord(before) || !isPlainRecord(after)) return [];
  return Object.keys(before).filter((key) => !(key in after));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The third state a READ can be in, which the executor has no reason to know
 * about: the panel answered `2xx`, a body arrived, and the thing we asked for
 * is not findable in it.
 *
 * It is declared here rather than per client because all three domain clients
 * arrived at it independently, with the same rationale, under three different
 * names — and three structurally identical types are three places for the
 * meaning to drift apart.
 *
 * Why it must not be folded into `ok` with an empty payload: an empty list and
 * an unreadable answer are the difference between "we looked and there was
 * nobody" and "we could not look", and this integration decides whether to
 * accuse a customer of sharing on exactly that distinction. It must not be
 * folded into `rejected` either — nothing was refused, so a caller retrying on
 * rejection would retry a request that will keep succeeding.
 */
export type PanelReadOutcome<TResult> =
  | PanelCommandOutcome<TResult>
  | { readonly kind: 'unreadable'; readonly detail: string };

export function unreadable(detail: string): { readonly kind: 'unreadable'; readonly detail: string } {
  return { kind: 'unreadable', detail };
}
