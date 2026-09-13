/**
 * boot-smoke.cjs
 * ──────────────
 * Proves that the dependency graph of the BUILT application resolves: every
 * provider, controller, guard, interceptor and middleware reachable from
 * `AppModule` can be handed its constructor arguments. Needs no database, no
 * Redis and no `.env`.
 *
 * Usage — it reads `dist/`, so build first:
 *   npm run build
 *   npm run smoke:boot
 *
 * Why. Typecheck, lint, build and the unit suite can all be green while
 * `node dist/main.js` and `node dist/worker.js` abort at startup, because none
 * of them ever assembles `AppModule`: specs build narrow testing modules or
 * construct classes by hand, and the compiler cannot see that a module lacks a
 * provider. What prompted this script is exactly that, on NestJS 12 (see the
 * constructor of `AdminJwtAuthGuard`). That particular defect does not
 * reproduce on NestJS 11, so on 11 this script does not guard it. What it
 * guards on every version is wiring: a provider missing from its module or not
 * exported to the module that injects it, a token nobody provides.
 *
 * How. `preview: true` makes Nest scan every module and resolve every
 * dependency without calling a constructor or a factory, so nothing connects
 * anywhere. In preview, lifecycle hooks run only for Nest's own core module,
 * which is also why `close()` is safe here. `abortOnError: false` because the
 * default answers a resolution failure with `process.abort()` rather than an
 * error this script can print. `main.ts` and `worker.ts` boot this same
 * `AppModule`, so one graph covers both processes.
 *
 * What it does NOT prove: that constructors, factories, `onModuleInit` or
 * `listen()` succeed against real infrastructure, that a real deployment's
 * environment validates, or that `dist/main.js` itself evaluates.
 *
 * Environment. `AppModule` validates the environment while its file is being
 * evaluated (`ConfigModule.forRoot({ validate })`), so a format-valid dummy
 * environment is set below. `REZEIS_CRYPT_KEY` and `DATABASE_PASSWORD` are the
 * only keys `env.schema.ts` gives no default; when a new one appears this
 * script fails with the schema's message, and the key belongs in the list.
 * Database and Redis point at port 1 on loopback: nothing is meant to connect,
 * and if something ever does it is refused instead of reaching a developer's
 * local services. The working directory is an empty temporary one because
 * `ConfigModule` reads `.env` from there, and a developer's `.env` could
 * otherwise supply a key CI does not have — green here, red there.
 *
 * Exit codes: 0 resolved, 1 failed (reason printed), 2 timed out.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const APP_MODULE = path.join(PACKAGE_ROOT, 'dist', 'app.module.js');
const TIMEOUT_MS = 120_000;

const log = (message) => console.log(`[boot-smoke] ${message}`);

Object.assign(process.env, {
  NODE_ENV: 'development',
  REZEIS_CRYPT_KEY: 'boot-smoke-crypt-key-not-a-secret-0123456789',
  DATABASE_PASSWORD: 'boot-smoke',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '1',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '1',
});

const originalCwd = process.cwd();
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rezeis-boot-smoke-'));

function finish(code) {
  process.chdir(originalCwd);
  fs.rmSync(scratchCwd, { recursive: true, force: true });
  process.exit(code);
}

function nestCoreVersion() {
  try {
    return require('@nestjs/core/package.json').version;
  } catch {
    return 'unknown';
  }
}

async function run() {
  if (!fs.existsSync(APP_MODULE)) {
    log(`FAIL ${path.relative(PACKAGE_ROOT, APP_MODULE)} does not exist; run \`npm run build\` first`);
    return 1;
  }
  process.chdir(scratchCwd);
  // The first import of `main.ts` and `worker.ts`, kept first here too.
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(APP_MODULE);

  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  const moduleCount = app.container?.getModules?.().size;
  await app.close();
  log(
    `PASS AppModule dependency graph resolved` +
      `${moduleCount ? ` (${moduleCount} modules)` : ''} on @nestjs/core ${nestCoreVersion()}`,
  );
  return 0;
}

setTimeout(() => {
  log(`FAIL timed out after ${TIMEOUT_MS / 1000}s`);
  finish(2);
}, TIMEOUT_MS).unref();

run().then(finish, (error) => {
  log(`FAIL on @nestjs/core ${nestCoreVersion()}`);
  console.error(error instanceof Error && error.stack ? error.stack : error);
  finish(1);
});
