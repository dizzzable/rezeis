/**
 * THE ENTRY POINT OF THE PAIR'S END-TO-END SUITE — Linux CI and a Windows box
 * alike. Node 24 runs this file as it is (type stripping), so it needs nothing
 * installed to start; it installs the scenario runner's own dependencies when
 * they are missing.
 *
 *   node run-e2e.mts                         both halves built from the working trees, every scenario
 *   node run-e2e.mts --scenarios core        only what every pairing must pass
 *   PANEL_IMAGE=ghcr.io/dizzzable/rezeis:v0.9.7.70 \
 *   CABINET_IMAGE=ghcr.io/dizzzable/reiwa:v0.9.7.52 node run-e2e.mts --scenarios core
 *
 * `run-e2e.ps1` is a thin wrapper of this file, and the E2E workflows of both
 * repositories call it directly.
 *
 * WHICH IMAGES
 *   PANEL_IMAGE / --panel-image      a published panel image. Unset: ../rezeis-admin is built
 *                                    as rezeis-admin:e2e, which is what run-e2e.ps1 always did.
 *   CABINET_IMAGE / --cabinet-image  a published cabinet image. Unset: ../../reiwa (or REIWA_DIR)
 *                                    is built as reiwa:e2e.
 *   E2E_PULL=never / --no-pull       use images already on the daemon; by default a given
 *                                    image is pulled first, so `:main` and `:latest` are current.
 *
 * WHAT RUNS
 *   E2E_SCENARIOS / --scenarios      `all` (default) or `core`. A MIXED pair — halves of
 *                                    different versions — runs `core` only; the tags live
 *                                    next to the scenarios in e2e-runner.ts.
 *   E2E_PROBE                        `panel` or `cabinet`: the OTHER half of a workflow's next
 *                                    pair, an unreleased `:main` that may predate a pair change.
 *                                    Its pair features are probed instead of assumed; what it
 *                                    lacks is tested as it is and named in the summary. Never
 *                                    the half being built. Unset locally: nothing is probed.
 *   E2E_SUMMARY_NOTE                 lines for the summary saying how the workflow chose the pair
 *                                    (the released half, the floor), next to the runner's notes.
 *
 * WHERE
 *   E2E_PROJECT / --project          compose project, default `rezeis-e2e`. Every container,
 *                                    the network and the volumes are named after it.
 *   E2E_ADMIN_PORT, E2E_CABINET_PORT, E2E_DB_PORT
 *                                    host ports on 127.0.0.1 (18000, 15000, 15432).
 *   E2E_LOG_DIR                      full container logs and results.json (default ./.logs).
 *   E2E_SAVE_LOGS=1 / --save-logs    write every container's full log there after a PASSING
 *                                    run too (a failed run always does), e.g. to read what a
 *                                    mixed pair logs while its scenarios stay green.
 *   E2E_LABEL / --label              a name for this run in the CI job summary.
 *   --keep-alive                     leave the stack up afterwards; prints how to remove it.
 *
 * STAGES
 *   preflight → the suite typechecks (tsx would run it untyped) → images →
 *   clean slate → infrastructure → panel (API + worker) → first admin + the
 *   cabinet's API token → cabinet → every container healthy → scenarios →
 *   teardown.
 *
 * The panel's schema comes from the panel IMAGE: its entrypoint runs
 * `prisma migrate deploy` before Nest starts (docker-entrypoint.sh, role
 * `api`). The PowerShell script used to migrate from the host out of the
 * working tree, which is right for a local build and wrong for any released
 * panel — a mixed pair would have run the old panel on a newer schema.
 *
 * TEARDOWN ALWAYS RUNS — pass, fail or Ctrl+C — unless --keep-alive, and the
 * daemon is then ASSERTED clean for the project: a stack that outlives its run
 * hands the next run a database with an admin already in it.
 *
 * On a failure the run prints what CI needs to read without a rerun: every
 * container's state, the tail of every container's log (full logs go to
 * E2E_LOG_DIR), and the failing scenarios with the request and the answer.
 *
 * Exit codes: 0 passed · 1 a scenario failed · 2 the stack could not be built
 * or started · 3 only the teardown failed · 64 bad arguments · 130 interrupted.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(HERE, 'docker-compose.e2e.yml');

/** Every service docker-compose.e2e.yml declares, in start order. */
const SERVICES = [
  'rezeis-e2e-db',
  'rezeis-e2e-redis',
  'reiwa-e2e-redis',
  'rezeis-e2e-admin',
  'rezeis-e2e-worker',
  'reiwa-e2e-api',
] as const;
const INFRA_SERVICES = ['rezeis-e2e-db', 'rezeis-e2e-redis', 'reiwa-e2e-redis'] as const;

const LOCAL_PANEL_TAG = 'rezeis-admin:e2e';
const LOCAL_CABINET_TAG = 'reiwa:e2e';
const BUILD_STAMP_LABEL = 'org.rezeis.e2e.build';

// The same account the scenarios sign in with (e2e-runner.ts). Test values.
const BOOTSTRAP_LOGIN = 'e2eadmin';
const BOOTSTRAP_PASSWORD = 'e2eadmin-pass-9876';
const CABINET_TOKEN_NAME = 'reiwa-e2e';

const LOG_TAIL_LINES = 120;
const IN_GITHUB = process.env.GITHUB_ACTIONS === 'true';

type Selection = 'all' | 'core';
type Half = 'panel' | 'cabinet';

interface Options {
  readonly selection: Selection;
  readonly keepAlive: boolean;
  readonly saveLogs: boolean;
  readonly project: string;
  readonly panelImage: string | null;
  readonly cabinetImage: string | null;
  readonly pull: boolean;
  readonly adminPort: number;
  readonly cabinetPort: number;
  readonly dbPort: number;
  readonly logDir: string;
  readonly panelSource: string;
  readonly cabinetSource: string;
  readonly label: string | null;
}

interface ImageInfo {
  readonly ref: string;
  readonly how: 'built' | 'pulled' | 'local';
  readonly id: string;
  readonly version: string | null;
  readonly revision: string | null;
  /**
   * The release tag the image was built from (`v0.9.7.70`), or `null` for any
   * other build: `main`, a branch, a working tree. Not the version: an image
   * built from `main` reports the LAST release's number until the next one is
   * cut, and the scenario runner's pair table must count it as newer.
   */
  readonly release: string | null;
}

interface ScenarioRecord {
  readonly name: string;
  readonly tag: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly durationMs: number;
  readonly note?: string;
  readonly error?: string;
}

interface RunnerResults {
  readonly selection: Selection;
  readonly scenarios: readonly ScenarioRecord[];
  /** How the pairing was read: an unlisted release, the other half's probed `:main`. */
  readonly notes?: readonly string[];
}

/** A failure that ends the run with a known exit code. */
class RunFailure extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ── Output ────────────────────────────────────────────────────────────────

const useColor =
  !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || IN_GITHUB || Boolean(process.env.FORCE_COLOR));
const paint = (code: string) => (text: string): string => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const cyan = paint('36');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const dim = paint('2');

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function heading(title: string): void {
  say('');
  say(cyan(`── ${title} ──`));
}

function group<T>(title: string, body: () => T): T {
  if (IN_GITHUB) say(`::group::${title}`);
  else say(dim(`── ${title} ──`));
  try {
    return body();
  } finally {
    if (IN_GITHUB) say('::endgroup::');
  }
}

/** One GitHub annotation line, escaped as workflow commands require. */
function annotate(level: 'error' | 'warning' | 'notice', title: string, message: string): void {
  if (!IN_GITHUB) return;
  const escape = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  // A property value also escapes `:` and `,`, which end it.
  const property = (s: string): string => escape(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  say(`::${level} title=${property(title)}::${escape(message)}`);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

// ── Options ───────────────────────────────────────────────────────────────

const USAGE = `usage: node run-e2e.mts [--scenarios all|core] [--panel-image REF] [--cabinet-image REF]
                         [--no-pull] [--project NAME] [--label TEXT] [--save-logs] [--keep-alive]
Images default to local builds of ../rezeis-admin and ../../reiwa. See the header of run-e2e.mts.`;

const VALUE_FLAGS = new Set(['scenarios', 'panel-image', 'cabinet-image', 'project', 'label']);
const BOOLEAN_FLAGS = new Set(['no-pull', 'keep-alive', 'save-logs', 'help']);

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RunFailure(`${name}=${raw} is not a port number`, 64);
  }
  return port;
}

function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options | null {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) throw new RunFailure(`unexpected argument "${arg}"\n${USAGE}`, 64);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name) && eq === -1) {
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new RunFailure(`unknown option --${name}\n${USAGE}`, 64);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith('--')) {
      throw new RunFailure(`--${name} needs a value\n${USAGE}`, 64);
    }
    flags.set(name, value);
  }
  if (flags.has('help')) {
    say(USAGE);
    return null;
  }
  const text = (flag: string, envName: string): string | null => {
    const fromFlag = flags.get(flag);
    const raw = typeof fromFlag === 'string' ? fromFlag : env[envName];
    const trimmed = raw?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
  };

  const selection = text('scenarios', 'E2E_SCENARIOS') ?? 'all';
  if (selection !== 'all' && selection !== 'core') {
    throw new RunFailure(`scenarios must be "all" or "core", not "${selection}"`, 64);
  }
  const project = text('project', 'E2E_PROJECT') ?? 'rezeis-e2e';
  // Compose's own rule for project names.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) {
    throw new RunFailure(`project "${project}" must be lower-case letters, digits, "-" or "_"`, 64);
  }
  const pullEnv = env.E2E_PULL?.trim().toLowerCase();
  if (pullEnv && pullEnv !== 'always' && pullEnv !== 'never') {
    throw new RunFailure(`E2E_PULL must be "always" or "never", not "${env.E2E_PULL}"`, 64);
  }

  return {
    selection,
    keepAlive: flags.has('keep-alive'),
    saveLogs: flags.has('save-logs') || env.E2E_SAVE_LOGS === '1' || env.E2E_SAVE_LOGS === 'true',
    project,
    panelImage: text('panel-image', 'PANEL_IMAGE'),
    cabinetImage: text('cabinet-image', 'CABINET_IMAGE'),
    pull: !flags.has('no-pull') && pullEnv !== 'never',
    adminPort: parsePort('E2E_ADMIN_PORT', env.E2E_ADMIN_PORT, 18_000),
    cabinetPort: parsePort('E2E_CABINET_PORT', env.E2E_CABINET_PORT, 15_000),
    dbPort: parsePort('E2E_DB_PORT', env.E2E_DB_PORT, 15_432),
    logDir: resolve(HERE, env.E2E_LOG_DIR?.trim() || '.logs'),
    panelSource: resolve(HERE, '..', 'rezeis-admin'),
    cabinetSource: resolve(HERE, env.REIWA_DIR?.trim() || join('..', '..', 'reiwa')),
    label: text('label', 'E2E_LABEL'),
  };
}

// ── Processes ─────────────────────────────────────────────────────────────

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ExecOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Echo output line by line with this prefix while it runs. */
  readonly echo?: string;
  /** Hand the terminal to the child instead of capturing (the scenario runner). */
  readonly inherit?: boolean;
  /** Needed on Windows for npm, which is a .cmd shim there. Constant arguments only. */
  readonly shell?: boolean;
}

const children = new Set<ChildProcess>();

function lineEcho(prefix: string): { push(text: string): void; flush(): void } {
  let pending = '';
  return {
    push(text: string): void {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      // BuildKit's plain progress separates its steps with empty lines.
      for (const line of lines) if (line.trim() !== '') say(`${dim(prefix)}${line}`);
    },
    flush(): void {
      if (pending !== '') say(`${dim(prefix)}${pending}`);
      pending = '';
    },
  };
}

function exec(command: string, args: readonly string[], options: ExecOptions = {}): Promise<Captured> {
  return new Promise((settle) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      settle({ code, stdout, stderr });
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? HERE,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    const out = options.echo !== undefined ? lineEcho(options.echo) : null;
    const err = options.echo !== undefined ? lineEcho(options.echo) : null;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      out?.push(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      err?.push(text);
    });
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      children.delete(child);
      finish(127);
    });
    child.on('close', (code, signal) => {
      out?.flush();
      err?.flush();
      children.delete(child);
      finish(code ?? (signal ? 128 : 1));
    });
  });
}

function docker(args: readonly string[], options: ExecOptions = {}): Promise<Captured> {
  return exec('docker', args, options);
}

let interrupted = false;

function checkInterrupted(): void {
  if (interrupted) throw new RunFailure('interrupted', 130);
}

// ── Images ────────────────────────────────────────────────────────────────

async function inspectImage(
  ref: string,
): Promise<{
  id: string;
  version: string | null;
  revision: string | null;
  stamp: string | null;
  release: string | null;
} | null> {
  const r = await docker(['image', 'inspect', '--format', '{{json .}}', ref]);
  if (r.code !== 0) return null;
  const data = JSON.parse(r.stdout) as {
    Id: string;
    Config?: { Env?: string[] | null; Labels?: Record<string, string> | null };
  };
  const env = data.Config?.Env ?? [];
  const labels = data.Config?.Labels ?? {};
  const fromEnv = (key: string): string | null => {
    const entry = env.find((e) => e.startsWith(`${key}=`));
    const value = entry?.slice(key.length + 1).trim() ?? '';
    return value === '' ? null : value;
  };
  // Docker Publish stamps the ref it built as the OCI version label (`v0.9.7.70`
  // for a tag, `main` for a branch) and as `*_GIT_BRANCH`; a local build has
  // neither.
  const releaseTag = [
    labels['org.opencontainers.image.version'],
    fromEnv('REZEIS_GIT_BRANCH'),
    fromEnv('REIWA_GIT_BRANCH'),
  ].find((value) => typeof value === 'string' && /^v\d+(\.\d+)+$/.test(value));
  return {
    id: data.Id.replace(/^sha256:/, '').slice(0, 12),
    version:
      fromEnv('APP_VERSION') ?? fromEnv('REIWA_VERSION') ?? labels['org.opencontainers.image.version'] ?? null,
    revision:
      labels['org.opencontainers.image.revision'] ?? fromEnv('REZEIS_GIT_SHA') ?? fromEnv('REIWA_GIT_SHA') ?? null,
    stamp: labels[BUILD_STAMP_LABEL] ?? null,
    release: releaseTag ?? null,
  };
}

/**
 * Builds one half from its working tree and proves the tag holds THIS build.
 *
 * Neither the exit code nor "the image exists" can be the verdict. A failed
 * build leaves the previous run's image under the same tag, and on 2026-09-13 a
 * network reset inside `npm ci` cancelled both builds while the stand went on to
 * pass 17/17 against a panel and a cabinet a day and a half old. Each build is
 * stamped with this run's id as a label (metadata only; every cached layer
 * stays cached) and the stamp is what is checked.
 */
async function buildImage(half: Half, tag: string, context: string, buildId: string): Promise<ImageInfo> {
  if (!existsSync(join(context, 'Dockerfile'))) {
    const variable = half === 'panel' ? 'PANEL_IMAGE' : 'CABINET_IMAGE (or REIWA_DIR)';
    throw new RunFailure(`${half}: no Dockerfile in ${context}; set ${variable} to run a published image`, 2);
  }
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    checkInterrupted();
    say(dim(`[${half}] docker build ${context} → ${tag} (attempt ${attempt}/${attempts})`));
    const build = await docker(
      ['build', '--progress=plain', '--label', `${BUILD_STAMP_LABEL}=${buildId}`, '-t', tag, context],
      { echo: `[${half} build] ` },
    );
    const info = await inspectImage(tag);
    if (info?.stamp === buildId) {
      if (build.code !== 0) {
        say(yellow(`[${half}] docker build exited ${build.code}, but ${tag} carries this run's stamp; accepted`));
      }
      return { ref: tag, how: 'built', id: info.id, version: info.version, revision: info.revision, release: null };
    }
    // Usually the network (npm ci pulls about a thousand packages per image);
    // a second attempt reuses every layer that did finish.
    say(yellow(`[${half}] ${tag} was not rebuilt by this run (stamp ${info?.stamp ?? 'missing'})`));
  }
  throw new RunFailure(`${half}: ${tag} was not rebuilt by this run; the build failed, see its output above`, 2);
}

async function pullImage(half: Half, ref: string, pull: boolean): Promise<ImageInfo> {
  if (pull) {
    checkInterrupted();
    const started = Date.now();
    const r = await docker(['pull', '--quiet', ref]);
    if (r.code !== 0) {
      throw new RunFailure(
        `${half}: docker pull ${ref} failed (exit ${r.code}): ${lastLines(r.stderr || r.stdout, 5)}\n` +
          'An image that exists only on this daemon needs --no-pull (E2E_PULL=never).',
        2,
      );
    }
    say(dim(`[${half}] pulled ${ref} in ${seconds(Date.now() - started)}`));
  }
  const info = await inspectImage(ref);
  if (!info) throw new RunFailure(`${half}: ${ref} is not on this daemon`, 2);
  return {
    ref,
    how: pull ? 'pulled' : 'local',
    id: info.id,
    version: info.version,
    revision: info.revision,
    release: info.release,
  };
}

async function obtainImages(options: Options): Promise<{ panel: ImageInfo; cabinet: ImageInfo }> {
  const buildId = randomUUID().replace(/-/g, '');
  // The infrastructure images too, and only when missing: a run on a box that
  // has them never needs the network for them, and a fresh CI runner fetches
  // them while the app images are fetched rather than inside `compose up`.
  const infra = async (): Promise<void> => {
    const refs = ['postgres:17-alpine', 'valkey/valkey:9-alpine'];
    for (const ref of refs) {
      if (await inspectImage(ref)) continue;
      const r = await docker(['pull', '--quiet', ref]);
      if (r.code !== 0) throw new RunFailure(`docker pull ${ref} failed: ${lastLines(r.stderr, 5)}`, 2);
      say(dim(`[infra] pulled ${ref}`));
    }
  };
  const [panel, cabinet] = await Promise.all([
    options.panelImage
      ? pullImage('panel', options.panelImage, options.pull)
      : buildImage('panel', LOCAL_PANEL_TAG, options.panelSource, buildId),
    options.cabinetImage
      ? pullImage('cabinet', options.cabinetImage, options.pull)
      : buildImage('cabinet', LOCAL_CABINET_TAG, options.cabinetSource, buildId),
    infra(),
  ]);
  for (const [half, image] of [
    ['panel', panel],
    ['cabinet', cabinet],
  ] as const) {
    say(
      `  ${half.padEnd(8)} ${image.ref}  ${dim(
        `${image.how} · ${image.release ?? 'unreleased build'} · image ${image.id} · version ${image.version ?? 'unset'} · revision ${image.revision?.slice(0, 12) ?? 'unknown'}`,
      )}`,
    );
  }
  return { panel, cabinet };
}

// ── The stack ─────────────────────────────────────────────────────────────

class Stack {
  readonly options: Options;
  readonly panelImage: string;
  readonly cabinetImage: string;
  cabinetToken: string | null = null;

  constructor(options: Options, panelImage: string, cabinetImage: string) {
    this.options = options;
    this.panelImage = panelImage;
    this.cabinetImage = cabinetImage;
  }

  get adminBase(): string {
    return `http://127.0.0.1:${this.options.adminPort}`;
  }

  get cabinetBase(): string {
    return `http://127.0.0.1:${this.options.cabinetPort}`;
  }

  compose(args: readonly string[], options: ExecOptions = {}): Promise<Captured> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_PANEL_IMAGE: this.panelImage,
      E2E_CABINET_IMAGE: this.cabinetImage,
      E2E_ADMIN_PORT: String(this.options.adminPort),
      E2E_CABINET_PORT: String(this.options.cabinetPort),
      E2E_DB_PORT: String(this.options.dbPort),
    };
    // Only the cabinet's `up` needs the token; everything else sees the
    // placeholder default of the compose file.
    if (this.cabinetToken) env.REZEIS_E2E_TOKEN = this.cabinetToken;
    else delete env.REZEIS_E2E_TOKEN;
    return docker(['compose', '-p', this.options.project, '-f', COMPOSE_FILE, ...args], { ...options, env });
  }

  async up(services: readonly string[], timeoutSeconds: number, extra: readonly string[] = []): Promise<void> {
    checkInterrupted();
    const r = await this.compose(
      ['up', '--detach', '--wait', '--wait-timeout', String(timeoutSeconds), ...extra, ...services],
      { echo: '  ' },
    );
    if (r.code !== 0) {
      throw new RunFailure(`${services.join(', ')} did not come up healthy within ${timeoutSeconds} s`, 2);
    }
  }

  async containerStates(): Promise<Map<string, { state: string; health: string; status: string }>> {
    const r = await this.compose(['ps', '--all', '--format', 'json']);
    const states = new Map<string, { state: string; health: string; status: string }>();
    const text = r.stdout.trim();
    if (r.code !== 0 || text === '') return states;
    // Compose prints one object per line; releases before 2.21 printed an array.
    const rows = (
      text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    ) as Array<{ Service: string; State: string; Health?: string; Status?: string }>;
    for (const row of rows) {
      states.set(row.Service, { state: row.State, health: row.Health ?? '', status: row.Status ?? '' });
    }
    return states;
  }

  /**
   * Every declared container is running, and healthy where it has a probe.
   *
   * Only the admin and the cabinet are reachable from the runner, so a
   * container that exits at boot is INVISIBLE to every scenario: the worker
   * publishes no port and nothing depends_on it, and both redises are only
   * ever touched through the two APIs. A missing env var there used to read
   * as a clean 15/15.
   */
  async assertEveryContainerUp(): Promise<void> {
    const deadline = Date.now() + 90_000;
    let bad: string[] = [];
    for (;;) {
      checkInterrupted();
      const states = await this.containerStates();
      bad = [];
      for (const service of SERVICES) {
        const s = states.get(service);
        if (!s) bad.push(`${service}: not created`);
        else if (s.state !== 'running') bad.push(`${service}: ${s.state} (${s.status})`);
        else if (s.health !== '' && s.health !== 'healthy') bad.push(`${service}: ${s.health}`);
      }
      if (bad.length === 0 || Date.now() > deadline) break;
      await sleep(3_000);
    }
    if (bad.length > 0) throw new RunFailure(`containers not up: ${bad.join('; ')}`, 2);
    say(green(`  ${SERVICES.length}/${SERVICES.length} containers running and healthy`));
  }

  /** Volumes the project's containers mount, read before `down` removes the containers. */
  async mountedVolumes(): Promise<string[]> {
    const ids = await this.compose(['ps', '--all', '--quiet']);
    const list = ids.stdout.split(/\s+/).filter(Boolean);
    if (list.length === 0) return [];
    const r = await docker([
      'inspect',
      '--format',
      '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}',
      ...list,
    ]);
    return r.stdout.split(/\s+/).filter(Boolean);
  }

  /** Anything of this project still on the daemon, by the compose project label. */
  async leftovers(volumes: readonly string[]): Promise<string[]> {
    const label = `label=com.docker.compose.project=${this.options.project}`;
    const left: string[] = [];
    const containers = await docker(['ps', '--all', '--quiet', '--filter', label]);
    for (const id of containers.stdout.split(/\s+/).filter(Boolean)) left.push(`container ${id}`);
    const networks = await docker(['network', 'ls', '--quiet', '--filter', label]);
    for (const id of networks.stdout.split(/\s+/).filter(Boolean)) left.push(`network ${id}`);
    const labelled = await docker(['volume', 'ls', '--quiet', '--filter', label]);
    const seen = new Set(labelled.stdout.split(/\s+/).filter(Boolean));
    // The database keeps its data in an ANONYMOUS volume (postgres declares
    // one); whether it carries the label is compose's business, so the names
    // read off the containers are checked as well.
    for (const name of volumes) {
      const r = await docker(['volume', 'inspect', '--format', '{{.Name}}', name]);
      if (r.code === 0) seen.add(name);
    }
    for (const name of seen) left.push(`volume ${name}`);
    return left;
  }

  async tearDown(): Promise<boolean> {
    heading('Teardown');
    const volumes = await this.mountedVolumes();
    await this.compose(['down', '--volumes', '--remove-orphans', '--timeout', '10']);
    // The exit code of `down` is not the verdict: a teardown that removed
    // NOTHING prints the same as one that removed everything. The daemon is.
    let left = await this.leftovers(volumes);
    if (left.length > 0) {
      say(yellow(`  still present: ${left.join(', ')}; retrying`));
      await this.compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], { echo: '  ' });
      for (const item of left) {
        const [kind, id] = item.split(' ');
        if (kind === 'volume' && id) await docker(['volume', 'rm', '--force', id]);
      }
      left = await this.leftovers(volumes);
    }
    if (left.length > 0) {
      say(red('  TEARDOWN INCOMPLETE — these survived the run:'));
      for (const item of left) say(red(`    ${item}`));
      say(red(`  remove by hand: docker compose -p ${this.options.project} -f "${COMPOSE_FILE}" down -v`));
      annotate('error', 'E2E teardown incomplete', left.join(', '));
      return false;
    }
    say(green(`  nothing of project ${this.options.project} is left on the daemon`));
    return true;
  }

  /** Every container's full log into the log directory; returns the texts. */
  async saveLogs(): Promise<Map<string, { file: string; text: string }>> {
    mkdirSync(this.options.logDir, { recursive: true });
    const saved = new Map<string, { file: string; text: string }>();
    for (const service of SERVICES) {
      const logs = await this.compose(['logs', '--no-color', '--timestamps', service]);
      const text = `${logs.stdout}${logs.stderr}`;
      const file = join(this.options.logDir, `${service}.log`);
      writeFileSync(file, text);
      saved.set(service, { file, text });
    }
    return saved;
  }

  /** What CI needs to read a failure without a rerun. */
  async diagnostics(reason: string): Promise<void> {
    heading(`Diagnostics — ${reason}`);
    const ps = await this.compose([
      'ps',
      '--all',
      '--format',
      'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}',
    ]);
    say(ps.stdout.trimEnd() || dim('  (no containers)'));
    for (const [service, { file, text }] of await this.saveLogs()) {
      group(`${service} — last ${LOG_TAIL_LINES} lines (full log: ${file})`, () => {
        say(text.trim() === '' ? dim('  (no output)') : lastLines(text, LOG_TAIL_LINES));
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface HttpAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

async function http(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpAnswer> {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}

function expect(answer: HttpAnswer, status: number, what: string): Record<string, unknown> {
  if (answer.status !== status) {
    throw new RunFailure(`${what}: expected HTTP ${status}, got ${answer.status} — ${answer.text.slice(0, 500)}`, 2);
  }
  return (answer.body ?? {}) as Record<string, unknown>;
}

async function waitForHttp(url: string, what: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    checkInterrupted();
    try {
      const answer = await http('GET', url);
      if (answer.status === 200) return (answer.body ?? {}) as Record<string, unknown>;
      last = `HTTP ${answer.status} ${answer.text.slice(0, 200)}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(2_000);
  }
  throw new RunFailure(`${what} did not answer 200 within ${seconds(timeoutMs)} (last: ${last})`, 2);
}

/**
 * The first admin, and the API token the cabinet reaches the panel with.
 *
 * The cabinet reads its token from the environment at start, so it can only
 * be started after the panel has minted one — which is why the stack comes up
 * in two halves.
 */
async function bootstrapCabinetToken(stack: Stack): Promise<string> {
  const api = `${stack.adminBase}/api`;
  const status = expect(await http('GET', `${api}/admin/auth/status`), 200, 'GET /admin/auth/status');
  const credentials = { username: BOOTSTRAP_LOGIN, password: BOOTSTRAP_PASSWORD };
  let bearer: string;
  if (status.hasAdmins !== true) {
    const reg = expect(await http('POST', `${api}/admin/auth/register`, credentials), 200, 'POST /admin/auth/register');
    bearer = String(reg.accessToken ?? '');
    say(green('  registered the first admin'));
  } else {
    // Cannot happen on the clean slate this run starts from; kept so a
    // --keep-alive stack re-entered by hand still works.
    const login = expect(await http('POST', `${api}/admin/auth/login`, credentials), 200, 'POST /admin/auth/login');
    bearer = String(login.accessToken ?? '');
    say(yellow('  an admin already existed; signed in'));
  }
  if (bearer.length < 20) throw new RunFailure('the panel answered without an access token', 2);
  const auth = { Authorization: `Bearer ${bearer}` };
  const listed = await http('GET', `${api}/admin/api-tokens`, undefined, auth);
  expect(listed, 200, 'GET /admin/api-tokens');
  // A bare array. The PowerShell script read `.items` off it, got nothing, and
  // so never revoked a token left by an earlier run.
  const items = Array.isArray(listed.body) ? (listed.body as Array<{ id: string; name: string }>) : [];
  for (const old of items.filter((t) => t.name === CABINET_TOKEN_NAME)) {
    // The list never returns a secret, so an old token cannot be reused.
    await http('DELETE', `${api}/admin/api-tokens/${old.id}`, undefined, auth);
  }
  const created = expect(
    await http('POST', `${api}/admin/api-tokens`, { name: CABINET_TOKEN_NAME }, auth),
    201,
    'POST /admin/api-tokens',
  );
  const token = String(created.token ?? '');
  if (token === '') throw new RunFailure('POST /admin/api-tokens answered without a token', 2);
  say(green(`  API token ${String(created.id)} issued for the cabinet (${token.length} chars)`));
  return token;
}

// ── Scenarios ─────────────────────────────────────────────────────────────

/**
 * `npm ci` when the runner's packages are missing, or older than the lock.
 *
 * `npm ci` and not `npm install`: install rewrites package-lock.json, and on a
 * Windows checkout it rewrote the file's CRLF as LF on every run, leaving the
 * lock "modified" in git with nothing changed. `ci` only reads it.
 */
async function ensureRunnerDependencies(): Promise<void> {
  const installed = join(HERE, 'node_modules', '.package-lock.json');
  const present =
    existsSync(installed) &&
    ['tsx', 'axios'].every((name) => existsSync(join(HERE, 'node_modules', name, 'package.json')));
  const stale = present && statSync(join(HERE, 'package-lock.json')).mtimeMs > statSync(installed).mtimeMs;
  if (present && !stale) return;
  say(dim(`  ${stale ? 'package-lock.json is newer than node_modules' : 'runner dependencies missing'}: npm ci`));
  // npm is a .cmd shim on Windows and needs a shell there; the line is a
  // constant, handed over whole (Node deprecates arguments beside a shell).
  const windows = process.platform === 'win32';
  const r = await exec(
    windows ? 'npm ci --no-audit --no-fund' : 'npm',
    windows ? [] : ['ci', '--no-audit', '--no-fund'],
    { shell: windows, echo: '  [npm] ' },
  );
  if (r.code !== 0) throw new RunFailure(`npm ci in ${HERE} failed (exit ${r.code})`, 2);
}

/**
 * The suite must typecheck before it runs: tsx strips types without reading
 * them, so a runner that drifted from its own types (a context field declared
 * and never initialised) would run and send `Bearer undefined` (R1-10c).
 * Done before any image is built or pulled, so it costs seconds, not a build.
 */
async function typecheckSuite(): Promise<void> {
  await ensureRunnerDependencies();
  const tsc = join(HERE, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = await exec(process.execPath, [tsc, '-p', 'tsconfig.json']);
  if (r.code !== 0) {
    say(lastLines(`${r.stdout}${r.stderr}`, 40));
    throw new RunFailure('the suite does not typecheck (npm run typecheck in e2e/); see above', 2);
  }
  say(green('  e2e/ typechecks'));
}

async function runScenarios(
  stack: Stack,
  options: Options,
  resultsFile: string,
  images: { panel: ImageInfo; cabinet: ImageInfo },
): Promise<RunnerResults | null> {
  await ensureRunnerDependencies();
  checkInterrupted();
  mkdirSync(dirname(resultsFile), { recursive: true });
  rmSync(resultsFile, { force: true });
  const r = await exec(process.execPath, ['--import', 'tsx', 'e2e-runner.ts'], {
    inherit: true,
    env: {
      ...process.env,
      REZEIS_BASE: stack.adminBase,
      REIWA_BASE: stack.cabinetBase,
      E2E_SCENARIOS: options.selection,
      E2E_RESULTS_FILE: resultsFile,
      // Release build or not, for the pair table (e2e-runner.ts): the version
      // alone cannot say, see ImageInfo.release.
      E2E_PANEL_BUILD: images.panel.release === null ? 'next' : 'release',
      E2E_CABINET_BUILD: images.cabinet.release === null ? 'next' : 'release',
      // The pair scenarios read the containers' Redis and logs themselves.
      E2E_PROJECT: options.project,
      E2E_COMPOSE_FILE: COMPOSE_FILE,
      // What the compose file interpolates, so `docker compose exec/logs` from
      // the runner resolve the same project as the stack's own `up`.
      E2E_PANEL_IMAGE: stack.panelImage,
      E2E_CABINET_IMAGE: stack.cabinetImage,
      E2E_ADMIN_PORT: String(options.adminPort),
      E2E_CABINET_PORT: String(options.cabinetPort),
      E2E_DB_PORT: String(options.dbPort),
    },
  });
  if (!existsSync(resultsFile)) {
    throw new RunFailure(`the scenario runner exited ${r.code} without writing ${resultsFile}`, 1);
  }
  const results = JSON.parse(readFileSync(resultsFile, 'utf8')) as RunnerResults;
  const failed = results.scenarios.filter((s) => s.status === 'fail');
  if (r.code !== 0 && failed.length === 0) {
    throw new RunFailure(`the scenario runner exited ${r.code} with no failed scenario recorded`, 1);
  }
  return results;
}

// ── Summary ───────────────────────────────────────────────────────────────

interface Timing {
  readonly stage: string;
  readonly ms: number;
}

function writeJobSummary(input: {
  options: Options;
  images: { panel: ImageInfo; cabinet: ImageInfo } | null;
  versions: { panel: string | null; cabinet: string | null };
  results: RunnerResults | null;
  timings: readonly Timing[];
  verdict: string;
  notes: readonly string[];
}): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const { options, images, versions, results, timings, verdict, notes } = input;
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines: string[] = [];
  lines.push(`### E2E · ${cell(options.label ?? options.selection)}`);
  lines.push('');
  lines.push(`**${cell(verdict)}**`);
  lines.push('');
  for (const note of notes) lines.push(`> ${cell(note)}`, '>');
  if (notes.length > 0) lines.push('');
  lines.push('| Half | Image | Version |');
  lines.push('|---|---|---|');
  lines.push(`| Panel | \`${images?.panel.ref ?? options.panelImage ?? LOCAL_PANEL_TAG}\` | ${versions.panel ?? '—'} |`);
  lines.push(`| Cabinet | \`${images?.cabinet.ref ?? options.cabinetImage ?? LOCAL_CABINET_TAG}\` | ${versions.cabinet ?? '—'} |`);
  lines.push('');
  if (results) {
    lines.push(`Scenarios: \`${results.selection}\``);
    lines.push('');
    lines.push('| Scenario | Tag | Result | Time | Detail |');
    lines.push('|---|---|---|---|---|');
    for (const s of results.scenarios) {
      const detail = s.status === 'fail' ? (s.error ?? '') : (s.note ?? '');
      lines.push(
        `| ${cell(s.name)} | ${s.tag} | ${s.status.toUpperCase()} | ${s.status === 'skip' ? '' : seconds(s.durationMs)} | ${cell(detail.slice(0, 300))} |`,
      );
    }
    lines.push('');
  }
  lines.push(`Stages: ${timings.map((t) => `${t.stage} ${seconds(t.ms)}`).join(' · ')}`);
  lines.push('');
  appendFileSync(file, `${lines.join('\n')}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2), process.env);
  if (!options) return 0;

  const started = Date.now();
  const timings: Timing[] = [];
  const stage = async <T,>(name: string, body: () => Promise<T>): Promise<T> => {
    heading(name);
    const t0 = Date.now();
    try {
      return await body();
    } finally {
      timings.push({ stage: name, ms: Date.now() - t0 });
    }
  };

  say(cyan('rezeis-admin ↔ reiwa · end-to-end run'));
  say(`  scenarios  ${options.selection}`);
  say(`  panel      ${options.panelImage ?? `build ${options.panelSource} → ${LOCAL_PANEL_TAG}`}`);
  say(`  cabinet    ${options.cabinetImage ?? `build ${options.cabinetSource} → ${LOCAL_CABINET_TAG}`}`);
  say(`  project    ${options.project}${options.keepAlive ? ' (kept alive afterwards)' : ''}`);
  say(
    dim(
      `  ports      admin 127.0.0.1:${options.adminPort} · cabinet 127.0.0.1:${options.cabinetPort} · db 127.0.0.1:${options.dbPort}`,
    ),
  );

  let exitCode = 0;
  let images: { panel: ImageInfo; cabinet: ImageInfo } | null = null;
  let stack: Stack | null = null;
  let results: RunnerResults | null = null;
  const versions: { panel: string | null; cabinet: string | null } = { panel: null, cabinet: null };
  const resultsFile = join(options.logDir, 'results.json');
  let failure: string | null = null;

  try {
    await stage('Preflight', async () => {
      const info = await docker(['info', '--format', '{{.ServerVersion}}']);
      if (info.code !== 0) {
        throw new RunFailure('the Docker daemon is not reachable; start Docker Desktop or dockerd first', 2);
      }
      const composeVersion = await docker(['compose', 'version', '--short']);
      if (composeVersion.code !== 0) throw new RunFailure('`docker compose` is not available', 2);
      say(`  docker ${info.stdout.trim()} · compose ${composeVersion.stdout.trim()} · node ${process.version}`);
    });

    await stage('Suite', typecheckSuite);

    images = await stage('Images', () => obtainImages(options));
    const current = new Stack(options, images.panel.ref, images.cabinet.ref);
    stack = current;

    await stage('Clean slate', async () => {
      // A run that crashed or was killed leaves its project behind; this one
      // must not inherit its database.
      await current.compose(['down', '--volumes', '--remove-orphans', '--timeout', '5']);
      say(dim(`  project ${options.project} removed if it existed`));
    });

    await stage('Infrastructure', () => current.up(INFRA_SERVICES, 120));

    await stage('Panel (API + worker)', async () => {
      // The API's entrypoint migrates the fresh database before Nest listens;
      // the worker starts once the API is healthy (depends_on).
      await current.up(['rezeis-e2e-admin', 'rezeis-e2e-worker'], 300);
      const health = await waitForHttp(`${current.adminBase}/api/health`, 'the panel /api/health', 60_000);
      versions.panel = typeof health.version === 'string' ? health.version : null;
      say(green(`  panel up · version ${versions.panel ?? 'unknown'} · health ${String(health.status)}`));
    });

    current.cabinetToken = await stage('First admin + cabinet token', () => bootstrapCabinetToken(current));

    await stage('Cabinet', async () => {
      // --no-deps: the panel and the redis are up already and must not be
      // recreated around the token.
      await current.up(['reiwa-e2e-api'], 180, ['--no-deps']);
      const health = await waitForHttp(`${current.cabinetBase}/api/v1/health`, 'the cabinet /api/v1/health', 60_000);
      versions.cabinet = typeof health.version === 'string' ? health.version : null;
      say(green(`  cabinet up · version ${versions.cabinet ?? 'unknown'}`));
    });

    await stage('Every container up', () => current.assertEveryContainerUp());

    say('');
    say(cyan(`  pair: panel ${versions.panel ?? '?'} (${images.panel.ref}) ↔ cabinet ${versions.cabinet ?? '?'} (${images.cabinet.ref})`));

    results = await stage('Scenarios', () => runScenarios(current, options, resultsFile, images!));
    const failed = results?.scenarios.filter((s) => s.status === 'fail') ?? [];
    if (failed.length > 0) {
      exitCode = 1;
      failure = `${failed.length} scenario(s) failed`;
      await current.diagnostics(failure);
    } else if (options.saveLogs) {
      await current.saveLogs();
      say(dim(`  container logs saved to ${options.logDir}`));
    }
  } catch (err) {
    exitCode = err instanceof RunFailure ? err.exitCode : 2;
    failure = err instanceof Error ? err.message : String(err);
    say('');
    say(red(`  ${failure}`));
    if (!(err instanceof RunFailure)) say(dim(String((err as Error).stack ?? '')));
    // Interrupted, the reader wants the stack gone, not its logs.
    if (stack && !interrupted) await stack.diagnostics(failure);
  } finally {
    if (stack && !options.keepAlive) {
      const t0 = Date.now();
      const clean = await stack.tearDown();
      timings.push({ stage: 'Teardown', ms: Date.now() - t0 });
      if (!clean && exitCode === 0) {
        exitCode = 3;
        failure = 'teardown incomplete';
      }
    } else if (stack && options.keepAlive) {
      heading('Kept alive');
      say(yellow(`  admin   ${stack.adminBase}   cabinet ${stack.cabinetBase}`));
      say(yellow(`  remove with: docker compose -p ${options.project} -f "${COMPOSE_FILE}" down -v`));
    }
  }

  // How this pairing was read: the workflow's own resolution (E2E_SUMMARY_NOTE:
  // which release the mixed pair was pinned to, and why) and the runner's
  // (an unlisted release, the other half's probed `:main`). Not failures.
  const notes = [
    ...(process.env.E2E_SUMMARY_NOTE ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    ...(results?.notes ?? []),
  ];
  if (notes.length > 0) {
    heading('Notes');
    for (const note of notes) {
      say(yellow(`  ${note}`));
      annotate('notice', 'E2E pairing', note);
    }
  }

  // The failing scenarios once more, last, where a reader of a CI log looks.
  const failed = results?.scenarios.filter((s) => s.status === 'fail') ?? [];
  if (failed.length > 0) {
    heading('Failed scenarios');
    for (const s of failed) {
      say(red(`  × ${s.name} [${s.tag}]`));
      say(`    ${s.error ?? '(no detail)'}`);
      annotate('error', `E2E ${s.name}`, s.error ?? '');
    }
  } else if (failure && exitCode !== 0) {
    annotate('error', 'E2E run failed', failure);
  }

  const total = Date.now() - started;
  heading('Result');
  say(dim(`  ${timings.map((t) => `${t.stage} ${seconds(t.ms)}`).join(' · ')}`));
  let verdict: string;
  if (results && exitCode === 0) {
    const ran = results.scenarios.filter((s) => s.status !== 'skip');
    const skipped = results.scenarios.length - ran.length;
    verdict = `PASSED — ${ran.length}/${ran.length} ${options.selection === 'core' ? 'core ' : ''}scenarios${skipped > 0 ? ` (${skipped} skipped)` : ''} in ${seconds(total)}`;
    say(green(`  ${verdict}`));
  } else {
    verdict = `FAILED (exit ${exitCode}) — ${failure ?? 'unknown'} — after ${seconds(total)}`;
    say(red(`  ${verdict}`));
  }
  writeJobSummary({ options, images, versions, results, timings, verdict, notes });
  return exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    say(yellow(`\n  ${signal}: stopping, then tearing the stack down`));
    for (const child of children) child.kill(signal);
  });
}

/**
 * A failed image stage can leave the other half's pull or build still going,
 * so what is left is stopped. The exit waits for stdout: a Windows console
 * takes writes asynchronously, and a bare exit could cut the verdict off.
 */
function exitWith(code: number): void {
  for (const child of children) child.kill();
  process.stdout.write('', () => process.exit(code));
}

main().then(
  (code) => exitWith(interrupted && code !== 0 ? 130 : code),
  (err: unknown) => {
    const code = err instanceof RunFailure ? err.exitCode : 2;
    say(red(`run-e2e: ${err instanceof Error ? err.message : String(err)}`));
    exitWith(code);
  },
);
