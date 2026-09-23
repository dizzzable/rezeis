import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `.env.example` does not name a bot after the panel.
 *
 * `REIWA_BOT_USERNAME` is the fallback for the bot the advertising links send
 * customers to. Its example value was `RezeisBot`: the panel's name, and a
 * handle that is not the operator's — uncommented as it stood, it would send an
 * operator's customers to a stranger's bot. Commented examples count: they are
 * what an operator copies.
 */
function botUsernameExamples(): Array<{ readonly key: string; readonly value: string }> {
  const text = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
  const out: Array<{ readonly key: string; readonly value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^#?\s*([A-Z0-9_]*BOT_USERNAME)=(.*)$/.exec(line.trim());
    if (match !== null) out.push({ key: match[1], value: match[2].trim() });
  }
  return out;
}

describe('.env.example', () => {
  it('names no bot after the panel', () => {
    const examples = botUsernameExamples();

    assert.ok(
      examples.some((example) => example.key === 'REIWA_BOT_USERNAME'),
      'the bot username example is gone — nothing left to check',
    );
    for (const { key, value } of examples) {
      assert.doesNotMatch(value, /rezeis/i, `${key}=${value}`);
    }
  });
});
