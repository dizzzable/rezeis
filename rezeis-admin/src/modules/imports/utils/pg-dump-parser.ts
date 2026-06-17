/**
 * Minimal PostgreSQL `pg_dump` / `pg_dumpall` COPY-block parser.
 *
 * Remnawave's official backup script ships the bot database as a `pg_dumpall`
 * SQL file (gzipped), NOT a `database.json` export. To import from such a
 * backup we read the table data straight out of the `COPY ... FROM stdin;`
 * blocks — the bulk-load format dump uses for row data.
 *
 * COPY text format rules we honour:
 *   - rows are newline-separated; the block ends with a line that is exactly `\.`
 *   - columns are TAB-separated
 *   - `\N` (backslash-N) is SQL NULL
 *   - in-data control chars are backslash-escaped (`\t \n \r \\ \b \f \v`)
 *
 * This is intentionally scoped to the COPY data we need (no DDL/INSERT
 * handling) — it is not a general SQL parser.
 */

export interface PgCopyTable {
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<Record<string, string | null>>;
}

const COPY_HEADER = /^COPY\s+(?:[A-Za-z_][\w$]*\.)?"?([A-Za-z_][\w$]*)"?\s*\(([^)]*)\)\s+FROM\s+stdin;/;

/** Parse every `COPY <table> (...) FROM stdin;` block into keyed rows. */
export function parsePgCopyTables(sql: string): Map<string, PgCopyTable> {
  const out = new Map<string, PgCopyTable>();
  const lines = sql.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const header = COPY_HEADER.exec(lines[i]);
    if (header === null) {
      i++;
      continue;
    }
    const table = header[1];
    const columns = header[2]
      .split(',')
      .map((c) => c.trim().replace(/^"|"$/g, ''))
      .filter((c) => c.length > 0);
    const rows: Array<Record<string, string | null>> = [];
    i++;
    while (i < lines.length && lines[i] !== '\\.') {
      // A stray empty trailing line inside a block shouldn't happen, but guard.
      const fields = lines[i].split('\t');
      const row: Record<string, string | null> = {};
      for (let c = 0; c < columns.length; c++) {
        row[columns[c]] = decodeCopyField(fields[c]);
      }
      rows.push(row);
      i++;
    }
    out.set(table, { columns, rows });
    i++; // skip the terminating `\.`
  }
  return out;
}

/** Decode one COPY field: `\N` → null, otherwise unescape backslash sequences. */
function decodeCopyField(raw: string | undefined): string | null {
  if (raw === undefined || raw === '\\N') return null;
  if (!raw.includes('\\')) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i === raw.length - 1) {
      out += ch;
      continue;
    }
    const next = raw[++i];
    switch (next) {
      case 't': out += '\t'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      default: out += next; break;
    }
  }
  return out;
}

// ── Typed cell coercions ─────────────────────────────────────────────────────

export function pgBool(v: string | null): boolean {
  return v === 't' || v === 'true' || v === 'TRUE';
}

export function pgInt(v: string | null, fallback = 0): number {
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Telegram ids fit comfortably in a JS number (< 2^53). */
export function pgBigInt(v: string | null): number {
  return pgInt(v, 0);
}

/**
 * Parse a Postgres array literal (`{a,b,c}` / `{}`) into a string list.
 * Handles optional double-quoted elements. Sufficient for `uuid[]` / `bigint[]`
 * which never contain commas or quotes inside an element.
 */
export function pgArray(v: string | null): string[] {
  if (v === null) return [];
  const t = v.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return [];
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(',')
    .map((x) => x.trim().replace(/^"|"$/g, ''))
    .filter((x) => x.length > 0);
}

export function pgNumberArray(v: string | null): number[] {
  return pgArray(v)
    .map((x) => Number.parseInt(x, 10))
    .filter((n) => Number.isFinite(n));
}

export function pgJson(v: string | null): Record<string, unknown> | null {
  if (v === null) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Convert a Postgres timestamp (`2026-06-10 14:52:59.213265+00`) to an ISO
 * string. Falls back to the raw value when it can't be parsed.
 */
export function pgTimestampToIso(v: string | null): string | null {
  if (v === null) return null;
  let s = v.trim().replace(' ', 'T');
  // Normalise a bare `+00` / `-05` offset to `+00:00` so JS Date accepts it.
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** Heuristic: does this text look like a pg dump (has COPY data we can read)? */
export function looksLikePgDump(text: string): boolean {
  return /^COPY\s+(?:[A-Za-z_][\w$]*\.)?"?[A-Za-z_]/m.test(text);
}
