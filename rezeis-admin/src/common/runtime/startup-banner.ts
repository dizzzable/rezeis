/**
 * Startup banner
 * ──────────────
 * A small, pretty boot banner printed once per process (api / worker), in the
 * spirit of Remnawave's startup art. Written straight to stdout so it renders
 * as readable lines in `docker compose logs`; colour is opt-out via the
 * standard `NO_COLOR` env. Intentionally NOT routed through the Nest `Logger`
 * (the box-drawing art would be mangled by the structured log formatter).
 */

// CommonJS interop: `package.json` lives outside the TS source root, so an
// `import` would need extra tsconfig gymnastics. Mirrors the pattern already
// used by the update-checker service.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PACKAGE_JSON: { readonly version?: string } = require('../../../package.json');

const REZEIS_VERSION = (PACKAGE_JSON.version ?? '0.0.0').trim();

export type RezeisRole = 'api' | 'worker';

const WAVE = '▰▱'.repeat(22);
const RULE = '─'.repeat(44);

const useColor = process.env.NO_COLOR === undefined;
function paint(text: string, code: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const ROLE_LABELS: Record<RezeisRole, string> = {
  api: 'API · admin panel',
  worker: 'Background worker · schedules · queues',
};

/** Print the rezeis-admin boot banner for the given process role. */
export function printRezeisBanner(role: RezeisRole): void {
  const green = (s: string): string => paint(s, '32');
  const bold = (s: string): string => paint(s, '1');
  const dim = (s: string): string => paint(s, '2');

  const lines = [
    '',
    green(`  ${WAVE}`),
    `     ${bold('🛡️  R E Z E I S   A D M I N')}   ${dim('·')}   ${bold(`v${REZEIS_VERSION}`)}`,
    dim(`  ${RULE}`),
    `     ${dim('VPN management · billing · bot config')}`,
    `     Role     ${green(ROLE_LABELS[role])}`,
    `     Author   ${bold('dizzzable')}`,
    `     GitHub   ${dim('github.com/dizzzable/rezeis')}`,
    green(`  ${WAVE}`),
    '',
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}
