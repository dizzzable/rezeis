import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderCsv } from '../src/modules/partners/services/partner-csv-export.service';

describe('renderCsv', () => {
  it('renders simple rows with CRLF separators and BOM prefix', () => {
    const csv = renderCsv(['col1', 'col2'], [['a', 'b']]);
    assert.equal(csv, '\ufeffcol1,col2\r\na,b');
  });

  it('escapes commas, quotes, and newlines', () => {
    const csv = renderCsv(['col'], [['a,b'], ['"quoted"'], ['line1\nline2']]);
    // BOM + header + 3 escaped rows
    assert.equal(
      csv,
      '\ufeffcol\r\n"a,b"\r\n"""quoted"""\r\n"line1\nline2"',
    );
  });

  it('defangs Excel formula prefixes (=, +, -, @)', () => {
    const cases = [
      { input: '=cmd|"" /C calc"!A1', expectedPrefix: "'=" },
      { input: '+1+1', expectedPrefix: "'+" },
      { input: '-cmd', expectedPrefix: "'-" },
      { input: '@SUM(A1)', expectedPrefix: "'@" },
    ];
    for (const { input, expectedPrefix } of cases) {
      const csv = renderCsv(['col'], [[input]]);
      // After BOM + header CRLF, the row starts at index 8 ('col\r\n' is 5 chars + BOM)
      const rowStart = csv.indexOf('\r\n') + 2;
      const cell = csv.slice(rowStart);
      assert.ok(
        cell.startsWith(expectedPrefix) || cell.startsWith(`"${expectedPrefix}`),
        `row "${cell}" did not start with ${expectedPrefix}`,
      );
    }
  });

  it('handles empty and undefined-coerced strings without crashing', () => {
    const csv = renderCsv(['col'], [['']]);
    assert.equal(csv, '\ufeffcol\r\n');
  });
});
