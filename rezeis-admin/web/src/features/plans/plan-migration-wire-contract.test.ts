/**
 * THE PLAN MIGRATION WIRE, READ OFF THE BACKEND — not off the spec both sides
 * were written from.
 *
 * `plan-migration-api.test.ts` feeds each reader a body spelled out by hand, and
 * `plans-page-delete.test.tsx` answers the dialog with the bodies of
 * `plan-migration-wire.fixtures.ts`. Both stay green against a server that sends
 * something else: the fixtures come from the same understanding as the readers.
 * While the backend was built, that understanding went stale three times —
 * `ownership` grew `internalSquads`/`externalSquad`, preview rows grew `user`
 * and later pages lost their `summary`, and a new reason arrived whose `detail`
 * the dialog now parses. So, the answer written out first and agreement second:
 *
 *   1. the backend DECLARES the shapes written out here — its interfaces, read
 *      with the TypeScript parser, nested literals opened;
 *   2. the machine strings agree — the backend's code tables are imported and
 *      the dialog's tables compared with them;
 *   3. the controller serves each route a fetcher calls, and the route that
 *      answers is the one meant (Express answers from the first match);
 *   4. every fixture builder makes a body of the declared shape, and the readers
 *      read it back losing nothing;
 *   5. the backend logic the dialog mirrors — the twin `detail` it parses, the
 *      squad-ownership fold its fixtures compute — is RUN as the backend wrote it.
 *
 * Reading the backend from a test is deliberate, as in
 * `referrals-api-wire-contract.test.ts`. The service files import Nest and
 * Prisma, which CI's `web-quality` job does not install, so they are parsed and
 * never imported; only `plan-migration.codes.ts` and
 * `plan-migration.constants.ts`, which import nothing, are.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AxiosResponse } from 'axios'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  PLAN_MIGRATION_BENIGN_SKIP_REASONS as SERVER_BENIGN_SKIP_REASONS,
  PLAN_MIGRATION_REASONS as SERVER_REASONS,
  PLAN_MIGRATION_REFUSAL_CODES as SERVER_REFUSAL_CODES,
  PLAN_MIGRATION_WARNING_CODES as SERVER_WARNING_CODES,
} from '../../../../src/modules/plans/migrations/plan-migration.codes'
import { PLAN_MIGRATION_DETAIL_MAX_LENGTH } from '../../../../src/modules/plans/migrations/plan-migration.constants'
import {
  describeMigrationReason,
  describeProblemDetail,
  PLAN_MIGRATION_BENIGN_SKIP_REASONS,
  PLAN_MIGRATION_NOT_RETRYABLE_REASONS,
  PLAN_MIGRATION_PROBLEM_KINDS,
  PLAN_MIGRATION_REASON_CODES,
  PLAN_MIGRATION_REFUSAL_I18N_KEYS,
  PLAN_MIGRATION_WARNING_CODES,
  twinBlockerReason,
} from './plan-migration'
import {
  fetchPlanMigrationCurrent,
  fetchPlanMigrationRunStatus,
  fetchPlanSubscriptionsPage,
  previewPlanMigration,
  readPlanMigrationCurrent,
  readPlanMigrationPreview,
  readPlanMigrationRetry,
  readPlanMigrationRunStatus,
  readPlanMigrationStarted,
  readPlanSubscriptionsPage,
  retryPlanMigration,
  startPlanMigration,
} from './plan-migration-api'
import {
  foldWireSquadOwnership,
  WIRE_DETAIL_MAX_LENGTH,
  wireLimitValues,
  wireOwnership,
  wirePreview,
  wirePreviewRow,
  wireProblem,
  wireRunView,
  wireSkippedPreviewRow,
  wireSubscriptionItem,
  wireTwinBlockedDetail,
  wireUser,
  wireWarningCounts,
  type WireOwnership,
} from './plan-migration-wire.fixtures'

// ── Reading the backend ─────────────────────────────────────────────────────

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/modules/plans/migrations')

function backendSource(relative: string): ts.SourceFile {
  const file = resolve(MIGRATIONS, relative)
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

const QUERY_SERVICE = backendSource('plan-migration-query.service.ts')
const COMPUTE_UTIL = backendSource('plan-migration-compute.util.ts')
const FACTS_UTIL = backendSource('plan-migration-facts.util.ts')
const CODES = backendSource('plan-migration.codes.ts')
const MOVE_SERVICE = backendSource('plan-migration-move.service.ts')
const CONTROLLER = backendSource('controllers/admin-plan-migrations.controller.ts')
const DTO = backendSource('dto/plan-migration.dto.ts')

/** A declared type as one line: `{ a; b; }` over several lines reads `{ a; b }`. */
const squash = (text: string): string => text.replace(/\s+/g, ' ').replace(/;\s*\}/g, ' }').trim()

type Shape = string | { readonly [key: string]: Shape }
type ObjectShape = { readonly [key: string]: Shape }

function statementNamed<T extends ts.Statement>(
  source: ts.SourceFile,
  name: string,
  is: (statement: ts.Statement) => statement is T,
): T {
  const found = source.statements.find(
    (statement): statement is T =>
      is(statement) && (statement as unknown as { name?: ts.Identifier }).name?.text === name,
  )
  if (found === undefined) {
    throw new Error(`${name} is not declared in ${source.fileName} — it moved or was renamed`)
  }
  return found
}

function membersOf(members: ts.NodeArray<ts.TypeElement>, source: ts.SourceFile, where: string): ObjectShape {
  const shape: Record<string, Shape> = {}
  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) {
      throw new Error(`${where}: a member that is not a plain property — ${member.getText(source)}`)
    }
    const key = `${member.name.getText(source)}${member.questionToken === undefined ? '' : '?'}`
    shape[key] = ts.isTypeLiteralNode(member.type)
      ? membersOf(member.type.members, source, `${where}.${key}`)
      : squash(member.type.getText(source))
  }
  return shape
}

/** An interface as `key → declared type`, with inline object types opened. */
function declaredInterface(source: ts.SourceFile, name: string): ObjectShape {
  const declaration = statementNamed(source, name, ts.isInterfaceDeclaration)
  if (declaration.heritageClauses !== undefined) {
    throw new Error(`${name} now extends another interface — open that one here too`)
  }
  return membersOf(declaration.members, source, name)
}

/** The members of a union of string literals, `'A' | 'B'`. */
function declaredLiteralUnion(source: ts.SourceFile, name: string): string[] {
  const { type } = statementNamed(source, name, ts.isTypeAliasDeclaration)
  if (!ts.isUnionTypeNode(type)) throw new Error(`${name} is no longer a union`)
  return type.types.map((member) => {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) return member.literal.text
    throw new Error(`${name}: a member that is not a string literal — ${member.getText(source)}`)
  })
}

/** `PlanMigrationSkipReason`: a union of `typeof PLAN_MIGRATION_REASONS.X`, as the values those name. */
function declaredSkipReasons(): string[] {
  const { type } = statementNamed(CODES, 'PlanMigrationSkipReason', ts.isTypeAliasDeclaration)
  if (!ts.isUnionTypeNode(type)) throw new Error('PlanMigrationSkipReason is no longer a union')
  return type.types.map((member) => {
    if (ts.isTypeQueryNode(member) && ts.isQualifiedName(member.exprName)) {
      const value = (SERVER_REASONS as Readonly<Record<string, string>>)[member.exprName.right.text]
      if (value !== undefined) return value
    }
    throw new Error(`PlanMigrationSkipReason: a member that names no reason — ${member.getText(CODES)}`)
  })
}

/** The string elements of `export const NAME = ['a', 'b'] as const`. */
function declaredStringTuple(source: ts.SourceFile, name: string): string[] {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      let initializer = declaration.initializer
      if (initializer !== undefined && ts.isAsExpression(initializer)) initializer = initializer.expression
      if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) break
      return initializer.elements.map((element) => {
        if (ts.isStringLiteral(element)) return element.text
        throw new Error(`${name}: an element that is not a string literal`)
      })
    }
  }
  throw new Error(`${name} is not an array of string literals in ${source.fileName}`)
}

function decoratorCall(node: ts.HasDecorators, name: string): ts.CallExpression | undefined {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const { expression } = decorator
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === name) {
      return expression
    }
  }
  return undefined
}

function stringArgument(call: ts.CallExpression): string {
  const [argument] = call.arguments
  if (argument === undefined) return ''
  if (!ts.isStringLiteral(argument)) throw new Error(`a route path that is not a string literal — ${argument.getText()}`)
  return argument.text
}

const HTTP_STATUS: Readonly<Record<string, number>> = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204 }

interface DeclaredRoute {
  readonly handler: string
  readonly route: string
  readonly status: number
  readonly returns: string
}

/** The handlers of a controller class in declaration order — the order Express tries them in. */
function declaredRoutes(source: ts.SourceFile, className: string): DeclaredRoute[] {
  const controller = statementNamed(source, className, ts.isClassDeclaration)
  const base = decoratorCall(controller, 'Controller')
  if (base === undefined) throw new Error(`${className} has no @Controller`)
  const routes: DeclaredRoute[] = []
  for (const member of controller.members) {
    if (!ts.isMethodDeclaration(member)) continue
    for (const verb of ['Get', 'Post', 'Put', 'Patch', 'Delete']) {
      const call = decoratorCall(member, verb)
      if (call === undefined) continue
      const httpCode = decoratorCall(member, 'HttpCode')
      let status = verb === 'Post' ? 201 : 200
      if (httpCode !== undefined) {
        const [argument] = httpCode.arguments
        const code = argument !== undefined && ts.isPropertyAccessExpression(argument) ? HTTP_STATUS[argument.name.text] : undefined
        if (code === undefined) throw new Error(`${member.name.getText(source)}: an @HttpCode this check cannot read`)
        status = code
      }
      routes.push({
        handler: member.name.getText(source),
        route: `${verb.toUpperCase()} /${[stringArgument(base), stringArgument(call)].filter((part) => part.length > 0).join('/')}`,
        status,
        returns: squash(member.type?.getText(source) ?? ''),
      })
    }
  }
  return routes
}

/**
 * A top-level function of a backend file, RUN as written: its text transpiled
 * on its own and evaluated with `scope` as the only names it may reach. A
 * function that starts needing anything else fails here with a ReferenceError
 * naming it.
 */
function backendFunction<T>(source: ts.SourceFile, name: string, scope: Readonly<Record<string, unknown>>): T {
  const declaration = statementNamed(source, name, ts.isFunctionDeclaration)
  const { outputText } = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  const names = Object.keys(scope)
  const body = `${outputText.replace(/^export \{\};?\s*$/m, '')}\nreturn ${name};`
  return new Function(...names, body)(...names.map((key) => scope[key])) as T
}

// ── The answers, written out ────────────────────────────────────────────────

/** Every interface the five bodies are built from, as the backend must declare it. */
const DECLARED: Readonly<Record<string, { readonly source: ts.SourceFile; readonly shape: ObjectShape }>> = {
  PlanMigrationSubscriptionsPage: {
    source: QUERY_SERVICE,
    shape: {
      total: 'number',
      matched: 'number',
      items: 'readonly PlanMigrationSubscriptionItem[]',
      nextCursor: 'string | null',
    },
  },
  PlanMigrationSubscriptionItem: {
    source: QUERY_SERVICE,
    shape: {
      subscriptionId: 'string',
      user: 'MigrationUserView | null',
      status: "Exclude<SubscriptionStatus, 'DELETED'>",
      isTrial: 'boolean',
      expiresAt: 'string | null',
      remnawaveLinked: 'boolean',
      limits: {
        trafficLimit: 'number | null',
        deviceLimit: 'number',
        internalSquads: 'readonly string[]',
        externalSquad: 'string | null',
      },
      ownership: 'MigrationOwnershipView',
      flags: { pendingRenewalForPlan: 'boolean', scheduledTermOnPlan: 'boolean', sharedPanelProfile: 'boolean' },
    },
  },
  MigrationUserView: {
    source: FACTS_UTIL,
    shape: {
      id: 'string',
      name: 'string | null',
      username: 'string | null',
      telegramId: 'string | null',
      email: 'string | null',
    },
  },
  MigrationOwnershipView: {
    source: COMPUTE_UTIL,
    shape: {
      trafficLimit: 'MigrationOwnership',
      deviceLimit: 'MigrationOwnership',
      squads: 'MigrationOwnership',
      internalSquads: 'MigrationOwnership',
      externalSquad: 'MigrationOwnership',
    },
  },
  MigrationLimitValues: {
    source: COMPUTE_UTIL,
    shape: {
      trafficLimit: 'number | null',
      deviceLimit: 'number',
      internalSquads: 'readonly string[]',
      externalSquad: 'string | null',
      isTrial: 'boolean',
    },
  },
  PlanMigrationPreview: {
    source: QUERY_SERVICE,
    shape: {
      summary: 'readonly PlanMigrationPreviewSummary[] | null',
      rows: 'readonly PlanMigrationPreviewRow[]',
      nextCursor: 'string | null',
    },
  },
  PlanMigrationPreviewRow: {
    source: QUERY_SERVICE,
    shape: {
      subscriptionId: 'string',
      user: 'MigrationUserView | null',
      targetPlanId: 'string',
      before: 'MigrationLimitValues',
      after: 'MigrationLimitValues',
      kept: 'readonly MigrationKeptField[]',
      warnings: 'readonly PlanMigrationWarningCode[]',
      willSkip: 'PlanMigrationSkipReason | null',
      pushesToRemnawave: 'boolean',
    },
  },
  PlanMigrationPreviewSummary: {
    source: QUERY_SERVICE,
    shape: {
      targetPlanId: 'string',
      count: 'number',
      skipped: 'number',
      warnings: 'Record<PlanMigrationWarningCode, number>',
    },
  },
  PlanMigrationRunView: {
    source: QUERY_SERVICE,
    shape: {
      runId: 'string',
      status: "'QUEUED' | 'RUNNING' | 'COMPLETED'",
      totals: {
        total: 'number',
        pending: 'number',
        moved: 'number',
        skipped: 'number',
        failed: 'number',
        skippedByReason: 'Readonly<Record<string, number>>',
      },
      sync: { total: 'number', pending: 'number', completed: 'number', failed: 'number' },
      problems: 'readonly PlanMigrationProblem[]',
      problemsCursor: 'string | null',
      finished: 'boolean',
    },
  },
  PlanMigrationProblem: {
    source: QUERY_SERVICE,
    shape: {
      subscriptionId: 'string',
      user: 'MigrationUserView | null',
      targetPlanId: 'string',
      kind: 'PlanMigrationProblemKind',
      reason: 'string',
      detail: 'string | null',
    },
  },
}

/** The small bodies are declared inline on the handlers. */
const ROUTES: readonly DeclaredRoute[] = [
  {
    handler: 'listSubscriptions',
    route: 'GET /admin/plans/:planId/subscriptions',
    status: 200,
    returns: 'Promise<PlanMigrationSubscriptionsPage>',
  },
  {
    handler: 'preview',
    route: 'POST /admin/plans/:planId/migrations/preview',
    status: 200,
    returns: 'Promise<PlanMigrationPreview>',
  },
  {
    handler: 'startMigration',
    route: 'POST /admin/plans/:planId/migrations',
    status: 202,
    returns: 'Promise<{ readonly runId: string; readonly totalItems: number }>',
  },
  {
    handler: 'getCurrentRun',
    route: 'GET /admin/plans/:planId/migrations/current',
    status: 200,
    returns: 'Promise<{ readonly runId: string | null }>',
  },
  {
    handler: 'getRun',
    route: 'GET /admin/plans/:planId/migrations/:runId',
    status: 200,
    returns: 'Promise<PlanMigrationRunView>',
  },
  {
    handler: 'retry',
    route: 'POST /admin/plans/:planId/migrations/:runId/retry',
    status: 202,
    returns: 'Promise<{ readonly runId: string }>',
  },
]

const OWNERSHIP_VALUES: readonly WireOwnership[] = ['INHERITED', 'INDIVIDUAL', 'UNKNOWN']

/** What the declared names that are not interfaces admit. */
const LITERALS: Readonly<Record<string, readonly string[]>> = {
  MigrationOwnership: OWNERSHIP_VALUES,
  MigrationKeptField: ['trafficLimit', 'deviceLimit', 'squads'],
  PlanMigrationProblemKind: ['MOVE_FAILED', 'MOVE_SKIPPED', 'SYNC_FAILED'],
  PlanMigrationWarningCode: SERVER_WARNING_CODES,
  PlanMigrationSkipReason: [
    'NOT_ON_SOURCE_PLAN',
    'SUBSCRIPTION_DELETED',
    'SCHEDULED_TERM',
    'SHARED_PROFILE_TARGET_CONFLICT',
    'SHARED_PROFILE_TWIN_BLOCKED',
  ],
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether a body is what a declared type admits — keys exactly, recursively,
 * nullability and element types included. A declared type this does not know
 * THROWS: the backend declared something new, and what it means has to be
 * decided here, not guessed.
 */
function expectDeclared(value: unknown, type: Shape, path: string): void {
  if (typeof type !== 'string') {
    expect(isPlainObject(value), `${path} is an object`).toBe(true)
    const record = value as Record<string, unknown>
    expect(Object.keys(record).sort(), `${path}: the keys the server declares`).toEqual(Object.keys(type).sort())
    for (const [key, inner] of Object.entries(type)) expectDeclared(record[key], inner, `${path}.${key}`)
    return
  }
  if (type.endsWith(' | null')) {
    if (value !== null) expectDeclared(value, type.slice(0, -' | null'.length), path)
    return
  }
  const list = /^readonly (.+)\[\]$/.exec(type)
  if (list !== null) {
    expect(Array.isArray(value), `${path} is a list`).toBe(true)
    for (const [index, element] of (value as unknown[]).entries()) expectDeclared(element, list[1], `${path}[${index}]`)
    return
  }
  const declared = DECLARED[type]
  if (declared !== undefined) return expectDeclared(value, declared.shape, path)
  const literals = LITERALS[type] ?? (/^'[^']*'(?: \| '[^']*')*$/.test(type) ? type.split(' | ').map((member) => member.slice(1, -1)) : undefined)
  if (literals !== undefined) {
    expect(literals, `${path}: ${JSON.stringify(value)} is a ${type}`).toContain(value)
    return
  }
  switch (type) {
    case 'string':
      expect(typeof value, `${path} is a string`).toBe('string')
      return
    case 'number':
      expect(Number.isInteger(value), `${path} is a whole number`).toBe(true)
      return
    case 'boolean':
      expect(typeof value, `${path} is a boolean`).toBe('boolean')
      return
    case "Exclude<SubscriptionStatus, 'DELETED'>":
      expect(typeof value === 'string' && value.length > 0 && value !== 'DELETED', `${path} is a live status`).toBe(true)
      return
    case 'Record<PlanMigrationWarningCode, number>':
      return expectDeclared(value, Object.fromEntries(SERVER_WARNING_CODES.map((code) => [code, 'number'])), path)
    case 'Readonly<Record<string, number>>':
      expect(isPlainObject(value), `${path} is an object`).toBe(true)
      for (const [key, count] of Object.entries(value as object)) expectDeclared(count, 'number', `${path}.${key}`)
      return
  }
  throw new Error(`${path}: no rule for the declared type \`${type}\` — decide what it admits in this file`)
}

/** What crossing the wire does to a body. */
const overTheWire = <T>(body: T): unknown => JSON.parse(JSON.stringify(body))

// ── The bodies under test, built by the fixtures every suite uses ───────────

const TWIN_ID = 'cmf0twin0000000000000001'
const HELD_BACK_ID = 'cmf0held0000000000000002'
const NEUTRAL_VALUES = wireLimitValues({ trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null, isTrial: false })

const SUBSCRIPTIONS_PAGE = {
  total: 3,
  matched: 3,
  items: [
    wireSubscriptionItem('cmf0alice000000000000001', {
      user: wireUser('cmf0user00000000000000a1', { name: 'Alice', username: 'alice', telegramId: '77000000001' }),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      limits: { trafficLimit: 0, deviceLimit: 5, internalSquads: ['sq-eu'], externalSquad: null },
      ownership: wireOwnership({ deviceLimit: 'INDIVIDUAL', internalSquads: 'INDIVIDUAL' }),
      flags: { pendingRenewalForPlan: true, scheduledTermOnPlan: false, sharedPanelProfile: true },
    }),
    wireSubscriptionItem('cmf0bob00000000000000002', {
      user: wireUser('cmf0user00000000000000b2', { email: 'bob@example.test' }),
      status: 'EXPIRED',
      isTrial: true,
      remnawaveLinked: false,
      limits: { trafficLimit: null, deviceLimit: -1, internalSquads: [], externalSquad: 'sq-ext' },
      ownership: wireOwnership({ trafficLimit: 'UNKNOWN', externalSquad: 'UNKNOWN' }),
      flags: { pendingRenewalForPlan: false, scheduledTermOnPlan: true, sharedPanelProfile: false },
    }),
    wireSubscriptionItem('cmf0carol0000000000000003'),
  ],
  nextCursor: 'eyJleHBpcmVzQXQiOm51bGwsImlkIjoiY21mMGNhcm9sIn0',
}

const FIRST_PREVIEW_PAGE = wirePreview(
  [
    wirePreviewRow('cmf0alice000000000000001', 'plan-standard', {
      user: SUBSCRIPTIONS_PAGE.items[0].user,
      before: wireLimitValues({ trafficLimit: 0, deviceLimit: 5, internalSquads: ['sq-eu'], isTrial: true }),
      after: wireLimitValues({ trafficLimit: null, deviceLimit: 5, internalSquads: ['sq-eu'] }),
      kept: ['deviceLimit', 'squads'],
      warnings: ['TRIAL_BECOMES_REGULAR', 'TARGET_NOT_RENEWABLE'],
    }),
    wireSkippedPreviewRow(HELD_BACK_ID, 'plan-standard', 'SHARED_PROFILE_TWIN_BLOCKED', {
      user: wireUser('cmf0user00000000000000h2'),
    }),
    // An id that names no subscription: no user, neutral values.
    wireSkippedPreviewRow('cmf0gone0000000000000009', 'plan-premium', 'SUBSCRIPTION_DELETED', { values: NEUTRAL_VALUES }),
  ],
  { nextCursor: 'cmf0gone0000000000000009' },
)

const LATER_PREVIEW_PAGE = wirePreview(
  [wireSkippedPreviewRow(TWIN_ID, 'plan-standard', 'SCHEDULED_TERM', { user: wireUser('cmf0user00000000000000t1') })],
  { firstPage: false },
)

const SETTLED_RUN = wireRunView({
  runId: 'cmf0run00000000000000001',
  totals: { moved: 2, skipped: 3, failed: 2 },
  skippedByReason: { SCHEDULED_TERM: 1, SHARED_PROFILE_TWIN_BLOCKED: 1, UNKNOWN: 1 },
  sync: { completed: 1, failed: 1 },
  problems: [
    wireProblem('cmf0p1', {
      kind: 'MOVE_FAILED',
      reason: 'INTERNAL_ERROR',
      targetPlanId: 'plan-standard',
      detail: 'The move timed out waiting for the subscription. Retry.',
    }),
    wireProblem('cmf0p2', {
      kind: 'MOVE_FAILED',
      reason: 'SHARED_PROFILE_TWIN_BLOCKED',
      targetPlanId: 'plan-standard',
      user: wireUser('cmf0user00000000000000p2', { name: 'Held back' }),
      detail: wireTwinBlockedDetail([{ subscriptionId: 'cmf0p1', reason: 'INTERNAL_ERROR' }]),
    }),
    wireProblem(TWIN_ID, { kind: 'MOVE_SKIPPED', reason: 'SCHEDULED_TERM', targetPlanId: 'plan-standard' }),
    wireProblem(HELD_BACK_ID, {
      kind: 'MOVE_SKIPPED',
      reason: 'SHARED_PROFILE_TWIN_BLOCKED',
      targetPlanId: 'plan-standard',
      detail: wireTwinBlockedDetail([{ subscriptionId: TWIN_ID, reason: 'SCHEDULED_TERM' }]),
    }),
    wireProblem('cmf0p5', {
      kind: 'SYNC_FAILED',
      reason: 'SYNC_FAILED',
      targetPlanId: 'plan-premium',
      detail: 'Remnawave answered 502',
    }),
  ],
  problemsCursor: 'cmf0item0000000000000005',
})

const RUNNING_RUN = wireRunView({
  runId: 'cmf0run00000000000000002',
  status: 'RUNNING',
  totals: { pending: 40, moved: 10 },
  sync: { pending: 4, completed: 6 },
})

// ── 1. What the backend declares ────────────────────────────────────────────

describe('the bodies the backend declares', () => {
  it.each(Object.entries(DECLARED))('%s', (name, { source, shape }) => {
    expect(declaredInterface(source, name)).toEqual(shape)
  })

  it('the names those bodies use admit exactly these values', () => {
    expect(declaredLiteralUnion(COMPUTE_UTIL, 'MigrationOwnership')).toEqual(LITERALS.MigrationOwnership)
    expect(declaredLiteralUnion(COMPUTE_UTIL, 'MigrationKeptField')).toEqual(LITERALS.MigrationKeptField)
    expect(declaredLiteralUnion(QUERY_SERVICE, 'PlanMigrationProblemKind')).toEqual(LITERALS.PlanMigrationProblemKind)
    expect(declaredSkipReasons()).toEqual(LITERALS.PlanMigrationSkipReason)
    expect(declaredStringTuple(DTO, 'PLAN_MIGRATION_RETRY_SCOPES')).toEqual(['failed', 'sync'])
  })

  it('the controller serves these routes, `current` before `:runId` so that it is the one answering', () => {
    expect(declaredRoutes(CONTROLLER, 'AdminPlanMigrationsController')).toEqual(ROUTES)
  })
})

// ── 2. The machine strings ──────────────────────────────────────────────────

describe('the machine strings the dialog translates', () => {
  it('names every reason the server records, and no other', () => {
    expect([...PLAN_MIGRATION_REASON_CODES].sort()).toEqual(Object.values(SERVER_REASONS).sort())
    // A preview skip is a reason too, and the dialog has words for each.
    for (const skip of LITERALS.PlanMigrationSkipReason) expect(describeMigrationReason(skip).recognised).toBe(true)
  })

  it('names every refusal the server sends, and no other', () => {
    expect([...PLAN_MIGRATION_REFUSAL_I18N_KEYS.keys()].sort()).toEqual(Object.values(SERVER_REFUSAL_CODES).sort())
  })

  // The same codes; the ORDER is the dialog's own — what takes something away first.
  it('has words for every warning the server sends, and no other', () => {
    expect([...PLAN_MIGRATION_WARNING_CODES].sort()).toEqual([...SERVER_WARNING_CODES].sort())
  })

  it('takes the same skips as harmless, and knows the problem kinds', () => {
    expect([...PLAN_MIGRATION_BENIGN_SKIP_REASONS].sort()).toEqual([...SERVER_BENIGN_SKIP_REASONS].sort())
    // The held-back twin is never harmless, in any form (spec §9 A2).
    expect(SERVER_BENIGN_SKIP_REASONS.has('SHARED_PROFILE_TWIN_BLOCKED')).toBe(false)
    expect([...PLAN_MIGRATION_PROBLEM_KINDS]).toEqual(LITERALS.PlanMigrationProblemKind)
  })

  it('declines a retry only for failures the server records', () => {
    for (const reason of PLAN_MIGRATION_NOT_RETRYABLE_REASONS) expect(Object.values(SERVER_REASONS)).toContain(reason)
  })
})

// ── 3. The routes the fetchers call ─────────────────────────────────────────

describe('every fetcher calls the handler meant, and reads what that handler returns', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const ok = (data: unknown, status = 200): AxiosResponse => ({ data, status, statusText: '', headers: {}, config: {} as never })

  function routeMatches(declared: string, method: string, url: string): boolean {
    const [declaredMethod, declaredPath] = declared.split(' ')
    if (declaredMethod !== method) return false
    const pattern = declaredPath
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    return new RegExp(`^${pattern}$`).test(url)
  }

  /** The handler Express runs for a request: the first declared route that matches it. */
  function answeringHandler(method: string, url: string): string | undefined {
    return declaredRoutes(CONTROLLER, 'AdminPlanMigrationsController').find((route) =>
      routeMatches(route.route, method, url),
    )?.handler
  }

  const request = { groups: [{ targetPlanId: 'plan-standard', subscriptionIds: ['cmf0alice000000000000001'] }] }

  it.each<[string, 'get' | 'post', unknown, () => Promise<unknown>, unknown]>([
    ['listSubscriptions', 'get', SUBSCRIPTIONS_PAGE, () => fetchPlanSubscriptionsPage('plan-gold', { search: '' }), SUBSCRIPTIONS_PAGE],
    [
      'preview',
      'post',
      FIRST_PREVIEW_PAGE,
      () => previewPlanMigration('plan-gold', request, { cursor: null, limit: 50 }),
      FIRST_PREVIEW_PAGE,
    ],
    [
      'startMigration',
      'post',
      { runId: 'cmf0run00000000000000001', totalItems: 7 },
      () => startPlanMigration('plan-gold', request),
      { runId: 'cmf0run00000000000000001', totalItems: 7 },
    ],
    ['getCurrentRun', 'get', { runId: null }, () => fetchPlanMigrationCurrent('plan-gold'), { runId: null }],
    ['getRun', 'get', SETTLED_RUN, () => fetchPlanMigrationRunStatus('plan-gold', SETTLED_RUN.runId, {}), SETTLED_RUN],
    [
      'retry',
      'post',
      { runId: SETTLED_RUN.runId },
      () => retryPlanMigration('plan-gold', SETTLED_RUN.runId, 'failed'),
      { runId: SETTLED_RUN.runId },
    ],
  ])('%s', async (handler, method, body, call, read) => {
    const response = ok(overTheWire(body), method === 'post' ? 202 : 200)
    const spy =
      method === 'get' ? vi.spyOn(api, 'get').mockResolvedValue(response) : vi.spyOn(api, 'post').mockResolvedValue(response)
    await expect(call()).resolves.toEqual(read)
    const url = String((spy.mock.calls[0] as unknown[])[0])
    expect({ url, handler: answeringHandler(method.toUpperCase(), url) }).toEqual({ url, handler })
  })
})

// ── 4. The fixtures every suite answers with ────────────────────────────────

describe('the fixtures are bodies the server could send, and the readers lose nothing of them', () => {
  it('a page of subscriptions', () => {
    expectDeclared(SUBSCRIPTIONS_PAGE, 'PlanMigrationSubscriptionsPage', 'page')
    expect(readPlanSubscriptionsPage(overTheWire(SUBSCRIPTIONS_PAGE))).toEqual(SUBSCRIPTIONS_PAGE)
  })

  it('a first preview page, with the summary the server computes, and a later one without', () => {
    expectDeclared(FIRST_PREVIEW_PAGE, 'PlanMigrationPreview', 'firstPage')
    expectDeclared(LATER_PREVIEW_PAGE, 'PlanMigrationPreview', 'laterPage')
    // Counted as the server counts: skips inside `count`, warnings on moving rows only, every code present.
    expect(FIRST_PREVIEW_PAGE.summary).toEqual([
      {
        targetPlanId: 'plan-standard',
        count: 2,
        skipped: 1,
        warnings: wireWarningCounts({ TRIAL_BECOMES_REGULAR: 1, TARGET_NOT_RENEWABLE: 1 }),
      },
      { targetPlanId: 'plan-premium', count: 1, skipped: 1, warnings: wireWarningCounts() },
    ])
    expect(LATER_PREVIEW_PAGE.summary).toBeNull()
    expect(readPlanMigrationPreview(overTheWire(FIRST_PREVIEW_PAGE))).toEqual(FIRST_PREVIEW_PAGE)
    expect(readPlanMigrationPreview(overTheWire(LATER_PREVIEW_PAGE))).toEqual(LATER_PREVIEW_PAGE)
  })

  it('a run in progress and a settled one with a problem of every kind', () => {
    expectDeclared(RUNNING_RUN, 'PlanMigrationRunView', 'running')
    expectDeclared(SETTLED_RUN, 'PlanMigrationRunView', 'settled')
    expect(new Set(SETTLED_RUN.problems.map((problem) => problem.kind))).toEqual(new Set(LITERALS.PlanMigrationProblemKind))
    expect(readPlanMigrationRunStatus(overTheWire(RUNNING_RUN))).toEqual(RUNNING_RUN)
    expect(readPlanMigrationRunStatus(overTheWire(SETTLED_RUN))).toEqual(SETTLED_RUN)
    // `finished` as the server derives it: COMPLETED and no sync job pending.
    expect([RUNNING_RUN.finished, SETTLED_RUN.finished]).toEqual([false, true])
  })

  it('the three small bodies, as the handlers declare them', () => {
    expect(readPlanMigrationStarted(overTheWire({ runId: 'r', totalItems: 0 }))).toEqual({ runId: 'r', totalItems: 0 })
    expect(readPlanMigrationCurrent(overTheWire({ runId: 'r' }))).toEqual({ runId: 'r' })
    expect(readPlanMigrationCurrent(overTheWire({ runId: null }))).toEqual({ runId: null })
    expect(readPlanMigrationRetry(overTheWire({ runId: 'r' }))).toEqual({ runId: 'r' })
  })

  it('refuses a fixture the server could not send — the check is not blind', () => {
    const { user: _user, ...withoutUser } = FIRST_PREVIEW_PAGE.rows[0]
    expect(() => expectDeclared({ ...FIRST_PREVIEW_PAGE, rows: [withoutUser] }, 'PlanMigrationPreview', 'p')).toThrow()
    const { internalSquads: _internal, ...foldedOnly } = SUBSCRIPTIONS_PAGE.items[0].ownership
    expect(() =>
      expectDeclared({ ...SUBSCRIPTIONS_PAGE.items[0], ownership: foldedOnly }, 'PlanMigrationSubscriptionItem', 'i'),
    ).toThrow()
    expect(() => wireRunView({ runId: 'r', totals: { skipped: 2 }, skippedByReason: { SCHEDULED_TERM: 1 } })).toThrow()
  })
})

// ── 5. The backend logic the dialog mirrors, run as written ─────────────────

describe('the twin detail the dialog reads a reason from', () => {
  const describeTwinBlockers = backendFunction<
    (blockers: ReadonlyArray<{ readonly subscriptionId: string; readonly reason: string }>) => string
  >(MOVE_SERVICE, 'describeTwinBlockers', { PLAN_MIGRATION_DETAIL_MAX_LENGTH })

  it('is the detail the move records for a held-back twin', () => {
    expect(squash(MOVE_SERVICE.text)).toContain(
      'reason: PLAN_MIGRATION_REASONS.SHARED_PROFILE_TWIN_BLOCKED, detail: describeTwinBlockers(blockers),',
    )
  })

  it.each(Object.values(SERVER_REASONS))('names a blocker held back by %s so that the dialog reads it back', (reason) => {
    const one = [{ subscriptionId: TWIN_ID, reason }]
    const several = [
      ...one,
      { subscriptionId: 'cmf0twin0000000000000003', reason: 'INTERNAL_ERROR' },
      { subscriptionId: 'cmf0twin0000000000000004', reason: 'TARGET_DELETED' },
    ]
    for (const blockers of [one, several]) {
      const detail = describeTwinBlockers(blockers)
      expect(wireTwinBlockedDetail(blockers)).toBe(detail)
      expect(twinBlockerReason(detail)).toBe(reason)
    }
    expect(describeTwinBlockers(several)).toMatch(/; 2 more twin\(s\) cannot move either$/)
    expect(
      describeProblemDetail({
        subscriptionId: HELD_BACK_ID,
        user: null,
        targetPlanId: 'plan-standard',
        kind: 'MOVE_SKIPPED',
        reason: 'SHARED_PROFILE_TWIN_BLOCKED',
        detail: describeTwinBlockers(one),
      }),
    ).toEqual({ kind: 'blockerReason', reason: describeMigrationReason(reason) })
  })

  it('cuts a detail at the column’s length, and the dialog then shows it as it came', () => {
    expect(WIRE_DETAIL_MAX_LENGTH).toBe(PLAN_MIGRATION_DETAIL_MAX_LENGTH)
    const blockers = [{ subscriptionId: `cmf0${'x'.repeat(470)}`, reason: 'SCHEDULED_TERM' }]
    const detail = describeTwinBlockers(blockers)
    expect(detail).toHaveLength(PLAN_MIGRATION_DETAIL_MAX_LENGTH)
    expect(detail.endsWith('…')).toBe(true)
    expect(wireTwinBlockedDetail(blockers)).toBe(detail)
    expect(twinBlockerReason(detail)).toBeNull()
    expect(describeTwinBlockers([])).toBe(wireTwinBlockedDetail([]))
  })
})

describe('the squad ownership fold the fixtures compute', () => {
  const foldSquadOwnership = backendFunction<(internal: string, external: string) => string>(
    COMPUTE_UTIL,
    'foldSquadOwnership',
    {},
  )

  it.each(OWNERSHIP_VALUES.flatMap((internal) => OWNERSHIP_VALUES.map((external) => [internal, external] as const)))(
    'internal %s, external %s',
    (internal, external) => {
      expect(foldWireSquadOwnership(internal, external)).toBe(foldSquadOwnership(internal, external))
      expect(wireOwnership({ internalSquads: internal, externalSquad: external }).squads).toBe(
        foldSquadOwnership(internal, external),
      )
    },
  )
})
