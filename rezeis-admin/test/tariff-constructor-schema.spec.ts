import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
const migration = readFileSync(join(root, 'prisma', 'migrations', '20260728120000_tariff_constructor', 'migration.sql'), 'utf8');

describe('tariff constructor revision integrity migration', () => {
  it('binds every revision price module and duration to the same revision', () => {
    assert.match(schema, /model TariffConstructorRevisionModulePrice[\s\S]*revisionId\s+String[\s\S]*fields: \[moduleId, revisionId\][\s\S]*fields: \[durationId, revisionId\][\s\S]*@@unique\(\[revisionId, moduleId, durationId\]\)/);
    assert.match(migration, /FOREIGN KEY \("module_id", "revision_id"\)[\s\S]*REFERENCES "tariff_constructor_revision_modules"\("id", "revision_id"\)/);
    assert.match(migration, /FOREIGN KEY \("duration_id", "revision_id"\)[\s\S]*REFERENCES "tariff_constructor_revision_durations"\("id", "revision_id"\)/);
  });

  it('binds the published revision to the same constructor', () => {
    assert.match(migration, /FOREIGN KEY \("published_revision_id", "id"\) REFERENCES "tariff_constructor_revisions"\("id", "constructor_id"\)/);
  });

  it('documents forward-only recovery and trigger teardown order', () => {
    assert.match(migration, /Forward-only migration/);
    assert.match(migration, /drop immutable triggers[\s\S]*before their tables[\s\S]*drop prevent_tariff_constructor_revision_mutation/i);
  });
});
