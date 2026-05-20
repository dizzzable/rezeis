import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const projectRoot = join(__dirname, '..');

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), 'utf8')) as T;
}

type PackageJson = {
  main: string;
  scripts: Record<string, string>;
};

type NestCliProject = {
  type: string;
  sourceRoot: string;
  entryFile: string;
};

type NestCliJson = {
  projects: Record<string, NestCliProject>;
};

describe('runtime entrypoint contract', () => {
  it('keeps production API and worker scripts on explicit separate entrypoints', () => {
    const packageJson = readJsonFile<PackageJson>('package.json');

    assert.equal(packageJson.main, 'dist/main.js');
    assert.equal(packageJson.scripts['start:prod'], 'npm run start:prod:api');
    assert.equal(packageJson.scripts['start:prod:api'], 'node dist/main.js');
    assert.equal(packageJson.scripts['start:prod:worker'], 'node dist/worker.js');
    assert.ok(!packageJson.scripts['start:prod:api'].includes('worker.js'));
    assert.ok(!packageJson.scripts['start:prod:worker'].includes('main.js'));
  });

  it('keeps development API and worker scripts on explicit Nest CLI projects', () => {
    const packageJson = readJsonFile<PackageJson>('package.json');

    assert.equal(packageJson.scripts['start:dev'], 'npm run start:dev:api');
    assert.equal(packageJson.scripts['start:dev:api'], 'nest start app --watch');
    assert.equal(packageJson.scripts['start:dev:worker'], 'nest start worker --watch');
  });

  it('declares API and worker Nest CLI projects without adding a scheduler root', () => {
    const nestCli = readJsonFile<NestCliJson>('nest-cli.json');

    assert.deepEqual(nestCli.projects.app, {
      type: 'application',
      sourceRoot: 'src',
      entryFile: 'main',
    });
    assert.deepEqual(nestCli.projects.worker, {
      type: 'application',
      sourceRoot: 'src',
      entryFile: 'worker',
    });
    assert.equal(nestCli.projects.scheduler, undefined);
  });
});
