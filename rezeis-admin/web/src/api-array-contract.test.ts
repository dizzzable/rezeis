/**
 * `api.get<T[]>(url)` is an assertion, not a check.
 *
 * (Runs under the suite's default jsdom environment, not `node`: the shared
 * `setup-tests.ts` reaches for `window` at import time, so a per-file
 * environment override fails before this file is even loaded. Nothing here
 * needs a DOM — it only reads the filesystem through the TypeScript API.)
 *
 * Axios never verifies the type argument. When an endpoint answers with
 * something that is not an array — `{}`, a `{ data: [...] }` envelope, or an
 * HTML error page served with HTTP 200 — the value arrives at a component
 * typed `T[]` and throws at the first `.map` *inside render*. `router.tsx`
 * wraps every route in `RouteErrorBoundary`, so the operator does not get a
 * white screen: they get the route's entire content replaced by a generic
 * "something went wrong" card, with the nav still intact. Total content loss,
 * silently, from one endpoint.
 *
 * The HTML case is not hypothetical. `web/nginx.conf` is
 * `try_files $uri $uri/ /index.html` with no `/api` location, so in that
 * deployment a stale `/api` path returns `index.html` with status 200 as a
 * **string**. A string has a working `.length`, so it walks past every
 * `length === 0` guard in the codebase before dying at `.map`.
 *
 * ── THE TWO RULES ──────────────────────────────────────────────────────────
 *
 * Rule A (producers). Every function whose CHECKER-RESOLVED return type is an
 * array (or a promise of one) and whose body calls `api.get|post|put|patch|
 * delete` must also contain a runtime check: a zod `.parse` / `.safeParse`,
 * `expectArray(`, `unwrapPayloadOrArray(`, or a bare `Array.isArray(`.
 *
 * Rule B (consumers). Every `useQuery`-family call whose resolved `queryFn`
 * reaches `api.<verb>` without such a check must not let the destructured
 * `data` reach an array method, a spread, a `for..of`, or an array
 * destructure. Rule B is deliberately NOT scoped to endpoints the checker
 * already calls arrays: that is what makes it a second net rather than a
 * restatement of Rule A. Its subjects today are the ~100 object-returning
 * endpoints, and it asserts none of them is being read as a list.
 *
 * ── WHY THE TYPE CHECKER AND NOT `ts.createSourceFile` ─────────────────────
 *
 * `Promise<Plan[]>`, `Promise<readonly Plan[]>`, and the inferred return of
 * `queryFn: async () => (await api.get<AddOn[]>(…)).data` are three spellings
 * of one fact, and only the checker unifies them. A text-based count of this
 * exact class returned 8. The checker returns 92.
 *
 * ── WHAT THIS GUARD CANNOT CATCH ───────────────────────────────────────────
 *
 * Stated so the next reader knows the size of the hole rather than trusting a
 * green run:
 *
 *  1. A cast that launders the type. `api.get('/x') as Promise<unknown>`, or a
 *     `queryFn` annotated `Promise<any>`, drops out of Rule A's subject set
 *     entirely. Rule B is the backstop for exactly this — but only if the
 *     value flows through a `useQuery`.
 *  2. **`expectArray` called on a DIFFERENT value than the one returned.**
 *     This is the largest hole by far. The rule reads "does the body contain
 *     a check", not "is the checked value the returned value" — it cannot
 *     tell `return expectArray(a)` from `expectArray(a); return b`.
 *  3. An `Array.isArray` in an unrelated branch — e.g. one narrowing a
 *     *request argument* — satisfies Rule A while the response goes unchecked.
 *  4. A wrapper more than one hop away. Validation is followed through a
 *     single directly-called local helper (that is how `referrals-page`'s
 *     `unwrap()` is recognised). Two hops and the rule reports a violation;
 *     three and it would report a false pass if the intermediate hop happened
 *     to contain a matching token.
 *  5. `queryClient.setQueryData` writes. A mutation result written into the
 *     cache reaches a component on a *different route* with no `queryFn`
 *     anywhere in the path, so Rule B never sees it. `saveCustomIcons` →
 *     `panel-icons-tab` → `IconPicker` is that shape; it is covered by hand
 *     (Rule A applies to the mutation function itself) and not by the rule.
 *  6. Element-level drift. `expectArray<Plan>` proves the container and
 *     nothing about what is inside it. A `[{}]` still throws wherever an
 *     element field is dereferenced. Only a `z.array(schema)` closes that,
 *     and only two endpoints here use one.
 *  7. A dereference inside a third party. `<AreaChart data={data}>` at
 *     `advertising-page.tsx:622` hands the value to Recharts, which throws
 *     inside its own code; no first-party `.map` appears at that site.
 *  8. Cross-component flow beyond two hops, and flow through a module-level
 *     store rather than props.
 *
 * Point 9 is the one that can open by itself, so it is asserted rather than
 * listed: `useSuspenseQuery`, `useSuspenseInfiniteQuery`, `fetchQuery`,
 * `ensureQueryData`, `prefetchQuery` and router `loader:` are all absent from
 * this tree today, and Rule B understands none of them. If one appears, the
 * rule acquires a blind spot with no other symptom — so their absence is a
 * test, not a comment.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── shared detector core ────────────────────────────────────────────────────

const API_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'request'])
const ZOD_PARSE = /^(parse|safeParse|parseAsync|safeParseAsync)$/
const VALIDATOR_CALLS = new Set(['expectArray', 'unwrapPayloadOrArray'])
const QUERY_HOOKS = new Set([
  'useQuery',
  'useInfiniteQuery',
  'useSuspenseQuery',
  'useSuspenseInfiniteQuery',
])
/** Array operations that throw on a non-array (`.length` does not — that is the point). */
const THROWING_MEMBERS = new Set([
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'slice', 'find', 'findIndex',
  'findLast', 'some', 'every', 'flatMap', 'flat', 'sort', 'toSorted', 'join',
  'includes', 'concat', 'indexOf', 'reverse', 'at', 'entries', 'keys', 'values', 'with',
])

/**
 * The four function forms that can carry a body. Narrower than TypeScript's
 * own `SignatureDeclaration`, which also covers call/construct signatures —
 * those have no `body`, and every detector below reads one.
 */
type FnLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration

const isFn = (n: ts.Node | undefined): n is FnLike =>
  !!n &&
  (ts.isFunctionDeclaration(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isMethodDeclaration(n))

interface Producer {
  readonly file: string
  readonly line: number
  readonly name: string
  readonly returnType: string
  readonly apiCall: string
  readonly validators: readonly string[]
}

interface Consumer {
  readonly file: string
  readonly line: number
  readonly component: string
  readonly queryFn: string
  readonly validators: readonly string[]
  readonly derefs: readonly string[]
}

function createScanner(program: ts.Program, root: string) {
  const checker = program.getTypeChecker()
  const rel = (f: string) => path.relative(root, f).split(path.sep).join('/')
  const lineOf = (n: ts.Node) => {
    const sf = n.getSourceFile()
    return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  }

  function isArrayLike(type: ts.Type | undefined): boolean {
    if (!type) return false
    if (type.isUnion()) return type.types.some(isArrayLike)
    if (checker.isArrayType(type) || checker.isTupleType(type)) return true
    const symbol = type.getSymbol()
    return !!symbol && (symbol.getName() === 'Array' || symbol.getName() === 'ReadonlyArray')
  }

  /** Return type with `Promise<>` peeled off, or undefined when unresolvable. */
  function awaitedReturn(decl: FnLike): ts.Type | undefined {
    try {
      const signature = checker.getSignatureFromDeclaration(decl)
      if (!signature) return undefined
      const returned = checker.getReturnTypeOfSignature(signature)
      return checker.getAwaitedType(returned) ?? returned
    } catch {
      return undefined
    }
  }

  /** Resolve an identifier / property name to the function it names. */
  function resolveFn(node: ts.Node): FnLike | null {
    try {
      let symbol = checker.getSymbolAtLocation(node)
      if (!symbol) return null
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
      for (const decl of symbol.getDeclarations() ?? []) {
        if (isFn(decl)) return decl
        if (ts.isVariableDeclaration(decl) && decl.initializer && isFn(decl.initializer)) {
          return decl.initializer
        }
        if (ts.isPropertyAssignment(decl) && isFn(decl.initializer)) return decl.initializer
        if (ts.isShorthandPropertyAssignment(decl)) {
          const target = checker.getShorthandAssignmentValueSymbol(decl)
          for (const inner of target?.getDeclarations() ?? []) {
            if (isFn(inner)) return inner
            if (ts.isVariableDeclaration(inner) && inner.initializer && isFn(inner.initializer)) {
              return inner.initializer
            }
          }
        }
      }
      return null
    } catch {
      return null
    }
  }

  /** `api.get` / `apiClient.post` / `remnawaveApi.get` … reached from this body. */
  function apiCallIn(fn: FnLike): string | null {
    let found: string | null = null
    const visit = (n: ts.Node): void => {
      if (found) return
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const verb = n.expression.name.text
        const base = n.expression.expression.getText()
        if (API_VERBS.has(verb) && (/(^|\.)api$/.test(base) || base === 'apiClient')) {
          found = `${base}.${verb}`
          return
        }
      }
      ts.forEachChild(n, visit)
    }
    if (fn.body) visit(fn.body)
    return found
  }

  /**
   * Validation tokens in this body, following ONE hop into a directly-called
   * local helper (blind spot 4 in the header). Depth is capped rather than
   * unbounded on purpose: an unbounded walk eventually reaches a helper that
   * happens to contain `Array.isArray` for unrelated reasons and turns the
   * rule into a rubber stamp.
   */
  function validatorsIn(fn: FnLike, depth = 0, seen = new Set<string>()): string[] {
    const found = new Set<string>()
    if (!fn.body) return []
    const key = `${fn.getSourceFile().fileName}:${fn.pos}`
    if (seen.has(key)) return []
    seen.add(key)
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression
        if (ts.isPropertyAccessExpression(callee)) {
          if (ZOD_PARSE.test(callee.name.text)) found.add('zod')
          if (
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'Array' &&
            callee.name.text === 'isArray'
          ) {
            found.add('Array.isArray')
          }
        }
        if (ts.isIdentifier(callee)) {
          if (VALIDATOR_CALLS.has(callee.text)) {
            found.add(callee.text)
          } else if (depth < 1) {
            const target = resolveFn(callee)
            if (target && target !== fn) {
              for (const v of validatorsIn(target, depth + 1, seen)) found.add(`${v} (via ${callee.text})`)
            }
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(fn.body)
    return [...found]
  }

  function nameOf(fn: FnLike): string {
    if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text
    if (ts.isMethodDeclaration(fn) && fn.name) return fn.name.getText()
    const parent = fn.parent
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent))) {
      return parent.name.getText()
    }
    return '<anonymous>'
  }

  // ── Rule A ───────────────────────────────────────────────────────────────

  function scanProducers(files: readonly ts.SourceFile[]): Producer[] {
    const rows: Producer[] = []
    const seen = new Set<string>()
    for (const sf of files) {
      const visit = (n: ts.Node): void => {
        if (isFn(n) && n.body) {
          const returned = awaitedReturn(n)
          if (isArrayLike(returned)) {
            const apiCall = apiCallIn(n)
            if (apiCall) {
              const key = `${rel(sf.fileName)}:${lineOf(n)}`
              if (!seen.has(key)) {
                seen.add(key)
                const signature = checker.getSignatureFromDeclaration(n)
                rows.push({
                  file: rel(sf.fileName),
                  line: lineOf(n),
                  name: nameOf(n),
                  returnType: signature
                    ? checker.typeToString(checker.getReturnTypeOfSignature(signature))
                    : '<unresolved>',
                  apiCall,
                  validators: validatorsIn(n),
                })
              }
            }
          }
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    return rows
  }

  // ── Rule B ───────────────────────────────────────────────────────────────

  /** Does this expression text reduce to one of the tainted names? */
  function passthrough(text: string, tainted: ReadonlySet<string>): string | null {
    const flat = text.replace(/\s+/g, ' ').trim()
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const name of tainted) {
      if (flat === name) return name
      if (new RegExp(`^\\(?\\s*${escape(name)}\\s*(\\?\\?|\\|\\|)\\s*\\[\\s*\\]\\s*\\)?$`).test(flat)) return name
      if (new RegExp(`^\\(?\\s*${escape(name)}\\s*(as [^)]+|!)\\s*\\)?$`).test(flat)) return name
    }
    return null
  }

  /**
   * Report array dereferences of `seeds` inside `scope`, growing the tainted
   * set through local aliases and following the value one hop into a child
   * component's props (30% of the real dereference sites in this tree are
   * reached that way, so a rule that stopped at the component boundary would
   * miss a third of them).
   */
  function derefsIn(
    scope: ts.Node,
    seeds: readonly string[],
    out: string[],
    depth = 0,
    visited = new Set<string>(),
  ): void {
    if (depth > 2) return
    const tainted = new Set(seeds)
    for (let round = 0; round < 3; round++) {
      let grew = false
      const grow = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
          if (passthrough(n.initializer.getText(), tainted) && !tainted.has(n.name.text)) {
            tainted.add(n.name.text)
            grew = true
          }
        }
        ts.forEachChild(n, grow)
      }
      grow(scope)
      if (!grew) break
    }

    const record = (n: ts.Node, what: string) => {
      const sf = n.getSourceFile()
      out.push(`${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  ${what}`)
    }

    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        THROWING_MEMBERS.has(n.name.text) &&
        n.parent &&
        ts.isCallExpression(n.parent) &&
        n.parent.expression === n
      ) {
        const base = passthrough(n.expression.getText(), tainted)
        if (base) record(n, `${base}.${n.name.text}()`)
      }
      if (ts.isSpreadElement(n) && n.parent && ts.isArrayLiteralExpression(n.parent)) {
        const base = passthrough(n.expression.getText(), tainted)
        if (base) record(n, `[...${base}]`)
      }
      if (ts.isForOfStatement(n)) {
        const base = passthrough(n.expression.getText(), tainted)
        if (base) record(n, `for..of ${base}`)
      }
      if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer) {
        const base = passthrough(n.initializer.getText(), tainted)
        if (base) record(n, `const [...] = ${base}`)
      }
      // one hop across a JSX prop into the child component
      if (
        ts.isJsxAttribute(n) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer) &&
        n.initializer.expression
      ) {
        const base = passthrough(n.initializer.expression.getText(), tainted)
        const element = n.parent?.parent as ts.JsxOpeningLikeElement | undefined
        const tagName = element && 'tagName' in element ? element.tagName.getText() : undefined
        if (base && tagName && /^[A-Z]/.test(tagName)) {
          const child = resolveFn(element!.tagName)
          const propName = n.name.getText()
          const visitKey = child ? `${child.getSourceFile().fileName}:${child.pos}:${propName}` : null
          if (child?.body && visitKey && !visited.has(visitKey)) {
            visited.add(visitKey)
            const param = child.parameters[0]
            let local: string | null = propName
            if (param && ts.isObjectBindingPattern(param.name)) {
              const element2 = param.name.elements.find(
                (e) => (e.propertyName ? e.propertyName.getText() : e.name.getText()) === propName,
              )
              local = element2 ? element2.name.getText() : null
            } else if (param && ts.isIdentifier(param.name)) {
              local = `${param.name.text}.${propName}`
            }
            if (local) derefsIn(child.body, [local], out, depth + 1, visited)
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(scope)
  }

  /**
   * The options object a query hook was actually handed.
   *
   * Three spellings occur here and all three must resolve, or the rule quietly
   * loses whole feature areas: an inline literal, `useQuery(fooOptions())`,
   * and `useQuery({ ...fooOptions(), enabled })` — the last is how `usePlans`
   * is written, i.e. the single highest-fan-out query in the app.
   */
  function optionsLiteralOf(call: ts.CallExpression): ts.ObjectLiteralExpression | null {
    const hasQueryFn = (obj: ts.ObjectLiteralExpression) =>
      obj.properties.some((p) => p.name?.getText() === 'queryFn')

    const fromFactory = (factoryCall: ts.CallExpression): ts.ObjectLiteralExpression | null => {
      const callee = factoryCall.expression
      const name = ts.isIdentifier(callee)
        ? callee
        : ts.isPropertyAccessExpression(callee)
          ? callee.name
          : null
      const factory = name && resolveFn(name)
      if (!factory?.body) return null
      let found: ts.ObjectLiteralExpression | null = null
      const visit = (n: ts.Node): void => {
        if (found) return
        if (ts.isObjectLiteralExpression(n) && hasQueryFn(n)) {
          found = n
          return
        }
        ts.forEachChild(n, visit)
      }
      visit(factory.body)
      return found
    }

    const arg = call.arguments[0]
    if (!arg) return null
    if (ts.isObjectLiteralExpression(arg)) {
      if (hasQueryFn(arg)) return arg
      for (const p of arg.properties) {
        if (!ts.isSpreadAssignment(p) || !ts.isCallExpression(p.expression)) continue
        const inner = fromFactory(p.expression)
        if (inner) return inner
      }
      return null
    }
    if (ts.isCallExpression(arg)) return fromFactory(arg)
    return null
  }

  function fnFromProp(prop: ts.ObjectLiteralElementLike | undefined): FnLike | null {
    if (!prop) return null
    const value = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : ts.isMethodDeclaration(prop)
        ? prop
        : null
    if (!value) return null
    if (isFn(value)) return value
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) {
      return resolveFn(ts.isPropertyAccessExpression(value) ? value.name : value)
    }
    return null
  }

  /**
   * The function that actually talks to the API, following ONE delegation hop.
   *
   * `queryFn: ({ signal }) => fetchPlans(signal)` is a function that contains
   * no `api.` call at all. Without this hop, every delegating `queryFn` — the
   * dominant style in this tree — is not a Rule B subject, and the rule
   * reports a clean run over the wrong population.
   */
  function endpointFnOf(fn: FnLike, depth = 0): FnLike | null {
    if (apiCallIn(fn)) return fn
    if (depth >= 1 || !fn.body) return null
    let found: FnLike | null = null
    const visit = (n: ts.Node): void => {
      if (found) return
      if (ts.isCallExpression(n)) {
        const callee = n.expression
        const name = ts.isIdentifier(callee)
          ? callee
          : ts.isPropertyAccessExpression(callee)
            ? callee.name
            : null
        const target = name && resolveFn(name)
        if (target && target !== fn) {
          const hit = endpointFnOf(target, depth + 1)
          if (hit) {
            found = hit
            return
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(fn.body)
    return found
  }

  function enclosingFn(n: ts.Node): FnLike | null {
    let cursor = n.parent
    while (cursor) {
      if (isFn(cursor)) return cursor
      cursor = cursor.parent
    }
    return null
  }

  /** Names the hook result's `data` is bound to at this call site. */
  function dataBindings(call: ts.CallExpression): string[] {
    let cursor: ts.Node = call.parent
    while (
      cursor &&
      (ts.isAsExpression(cursor) || ts.isParenthesizedExpression(cursor) || ts.isNonNullExpression(cursor))
    ) {
      cursor = cursor.parent
    }
    if (!cursor || !ts.isVariableDeclaration(cursor)) return []
    if (ts.isObjectBindingPattern(cursor.name)) {
      return cursor.name.elements
        .filter((e) => (e.propertyName ? e.propertyName.getText() : e.name.getText()) === 'data')
        .map((e) => e.name.getText())
    }
    if (ts.isIdentifier(cursor.name)) return [`${cursor.name.text}.data`]
    return []
  }

  /** Every call of `name` across the app — used to follow a custom hook out. */
  function callSitesOf(name: string, files: readonly ts.SourceFile[]): ts.CallExpression[] {
    const out: ts.CallExpression[] = []
    for (const sf of files) {
      if (!sf.text.includes(name)) continue
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const callee = n.expression
          const id = ts.isIdentifier(callee)
            ? callee
            : ts.isPropertyAccessExpression(callee)
              ? callee.name
              : null
          if (id?.text === name) out.push(n)
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    return out
  }

  function scanConsumers(files: readonly ts.SourceFile[]): Consumer[] {
    const rows: Consumer[] = []
    for (const sf of files) {
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const callee = n.expression
          const name = ts.isIdentifier(callee)
            ? callee
            : ts.isPropertyAccessExpression(callee)
              ? callee.name
              : null
          if (name && QUERY_HOOKS.has(name.text)) {
            const options = optionsLiteralOf(n)
            const declared = fnFromProp(
              options?.properties.find((p) => p.name?.getText() === 'queryFn'),
            )
            const fn = declared && endpointFnOf(declared)
            // Rule B's subject: a queryFn that reaches the API without a
            // check. NOT restricted to array-typed ones — that restriction is
            // exactly what a laundering cast would slip through.
            if (declared && fn) {
              const validators = [
                ...new Set([...validatorsIn(declared), ...validatorsIn(fn)]),
              ]
              if (validators.length === 0) {
                const derefs: string[] = []
                const owner = enclosingFn(n)
                const ownerName = owner ? nameOf(owner) : '<module>'
                const bindings = dataBindings(n)
                for (const binding of bindings) derefsIn(owner?.body ?? sf, [binding], derefs)
                // A custom hook (`usePlans`) returns the query result rather
                // than destructuring it, so the dereferences live at the
                // hook's CALL SITES, in other files. `fetchPlans` alone fans
                // out to 23 of them across 13 files; a rule that stopped at
                // this function body would have called that clean.
                if (bindings.length === 0 && /^use[A-Z]/.test(ownerName)) {
                  for (const site of callSitesOf(ownerName, files)) {
                    if (site === n) continue
                    const scope = enclosingFn(site)?.body ?? site.getSourceFile()
                    for (const binding of dataBindings(site)) derefsIn(scope, [binding], derefs)
                  }
                }
                // `select` reshapes the same unproven value before anyone sees it.
                const select = options?.properties.find((p) => p.name?.getText() === 'select')
                if (select && ts.isPropertyAssignment(select) && isFn(select.initializer)) {
                  const param = select.initializer.parameters[0]
                  if (param && ts.isIdentifier(param.name) && select.initializer.body) {
                    derefsIn(select.initializer.body, [param.name.text], derefs)
                  }
                }
                rows.push({
                  file: rel(sf.fileName),
                  line: lineOf(n),
                  component: ownerName,
                  queryFn: `${rel(fn.getSourceFile().fileName)}:${lineOf(fn)}`,
                  validators,
                  derefs: [...new Set(derefs)],
                })
              }
            }
          }
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    return rows
  }

  return { rel, scanProducers, scanConsumers }
}

// ── the real program ────────────────────────────────────────────────────────

function loadAppProgram(): ts.Program {
  const configPath = path.join(WEB_ROOT, 'tsconfig.app.json')
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    },
  } as ts.ParseConfigFileHost)
  if (!parsed) throw new Error(`could not parse ${configPath}`)
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  })
}

const program = loadAppProgram()
const scanner = createScanner(program, WEB_ROOT)
const appFiles = program
  .getSourceFiles()
  .filter(
    (sf) =>
      !sf.isDeclarationFile &&
      scanner.rel(sf.fileName).startsWith('src/') &&
      !/\.test\.tsx?$/.test(scanner.rel(sf.fileName)),
  )
const producers = scanner.scanProducers(appFiles)
const consumers = scanner.scanConsumers(appFiles)

describe('array-endpoint contract', () => {
  /**
   * A broken glob reports a spotless `[]` against zero files. This project has
   * hit that failure mode more than once, so the floors come first.
   */
  it('actually scanned the app (liveness floor)', () => {
    // Measured on this tree: 545 files, 92 producers, 90 Rule B subjects. The
    // floors sit well below those so a real refactor does not trip them, and
    // well above zero so a broken resolution step cannot report a clean run.
    expect(appFiles.length).toBeGreaterThan(400)
    expect(producers.length).toBeGreaterThan(50)
    // Rule B's subjects are the ~90 object-returning endpoints it proves are
    // not being read as lists. If this collapses, Rule B has become a green
    // test that guards nothing — which is the failure mode it exists to catch.
    expect(consumers.length).toBeGreaterThan(40)
  })

  it('Rule A — every array-returning api function validates its response', () => {
    const violations = producers
      .filter((p) => p.validators.length === 0)
      .map((p) => `${p.file}:${p.line}  ${p.name}(): ${p.returnType}   [${p.apiCall}]`)
    expect(
      violations,
      violations.length
        ? `\n${violations.length} endpoint(s) return an array to the UI without ever checking that the ` +
            `response IS one. Wrap the returned value in expectArray<T>() from @/lib/api-utils, or give ` +
            `it a z.array(...) schema when the consumer reads nested element fields:\n  ` +
            violations.join('\n  ') +
            '\n'
        : undefined,
    ).toEqual([])
  })

  it('Rule B — no unvalidated query result is read as an array', () => {
    const violations = consumers
      .filter((c) => c.derefs.length > 0)
      .map((c) => `${c.file}:${c.line} [${c.component}] <- ${c.queryFn}\n      ${c.derefs.join('\n      ')}`)
    expect(
      violations,
      violations.length
        ? `\n${violations.length} component(s) call an array method on a value no one proved is an ` +
            `array. On a {} / HTML-200 response this throws inside render and RouteErrorBoundary ` +
            `replaces the whole route:\n  ` +
            violations.join('\n  ') +
            '\n'
        : undefined,
    ).toEqual([])
  })

  /**
   * Rule B understands `useQuery` and `useInfiniteQuery` and nothing else.
   * The suspense hooks, the imperative `queryClient.*` fetches and router
   * loaders all reach a component by a path this scanner does not walk. They
   * are absent today; if one appears, the rule silently stops covering that
   * call site. Better to fail here and make someone teach the rule about it.
   */
  it('no fetch path exists that Rule B cannot see', () => {
    const unseen = /\b(useSuspenseQuery|useSuspenseInfiniteQuery|fetchQuery|ensureQueryData|prefetchQuery)\b/
    const found: string[] = []
    for (const sf of appFiles) {
      const match = unseen.exec(sf.text)
      if (match) found.push(`${scanner.rel(sf.fileName)}: ${match[1]}`)
      if (/^\s*loader:\s/m.test(sf.text) && scanner.rel(sf.fileName).includes('router')) {
        found.push(`${scanner.rel(sf.fileName)}: router loader`)
      }
    }
    expect(
      found,
      found.length
        ? `\nThese fetch paths bypass Rule B's queryFn resolution. Teach the scanner about them ` +
            `(QUERY_HOOKS / queryFnOf) before using them:\n  ${found.join('\n  ')}\n`
        : undefined,
    ).toEqual([])
  })
})

// ── detector self-tests ─────────────────────────────────────────────────────
//
// The rules above are only worth their runtime if the detector can tell the
// four cases apart. Run it against synthetic sources where the answer is
// known — a detector that flags nothing passes Rule A trivially.

const FIXTURE_PRELUDE = `
export const api = {
  get: async <T = unknown>(_url: string): Promise<{ data: T }> => ({ data: undefined as unknown as T }),
}
export function expectArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('errors.unexpectedResponsePayload')
  return value as T[]
}
`

function fixtureProgram(sources: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  }
  const all: Record<string, string> = { '/fx/api.ts': FIXTURE_PRELUDE, ...sources }
  const host = ts.createCompilerHost(options, true)
  const originalGet = host.getSourceFile.bind(host)
  const originalExists = host.fileExists.bind(host)
  const originalRead = host.readFile.bind(host)
  host.getSourceFile = (fileName, langVersion, onError, shouldCreate) =>
    fileName in all
      ? ts.createSourceFile(fileName, all[fileName], langVersion, true)
      : originalGet(fileName, langVersion, onError, shouldCreate)
  host.fileExists = (fileName) => fileName in all || originalExists(fileName)
  host.readFile = (fileName) => (fileName in all ? all[fileName] : originalRead(fileName))
  // `/fx` is not on disk, and module resolution short-circuits on
  // `directoryExists` before it ever asks `fileExists`. Without these two the
  // fixtures still COMPILE — `api` just resolves to `any`, every inferred
  // return becomes `Promise<any>`, and the self-tests below quietly stop
  // testing inference. That is why `scanFixture` asserts the fixture is
  // diagnostic-clean rather than trusting it.
  host.directoryExists = (dir) => dir === '/fx' || dir.startsWith('/fx/')
  host.realpath = (fileName) => fileName
  return ts.createProgram({ rootNames: Object.keys(all), options, host })
}

function scanFixture(source: string): Producer[] {
  const fixture = fixtureProgram({ '/fx/subject.ts': `import { api, expectArray } from './api'\n${source}` })
  const subject = fixture.getSourceFiles().filter((sf) => sf.fileName === '/fx/subject.ts')
  const errors = subject.flatMap((sf) => [
    ...fixture.getSemanticDiagnostics(sf),
    ...fixture.getSyntacticDiagnostics(sf),
  ])
  expect(
    errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    'the fixture must typecheck, or the detector is being fed `any` and proves nothing',
  ).toEqual([])
  const local = createScanner(fixture, '/fx')
  return local.scanProducers(subject)
}

describe('array-endpoint contract — detector self-tests', () => {
  it('flags a raw api.get<T[]>-and-return', () => {
    const found = scanFixture(`
      export async function listThings(): Promise<number[]> {
        const res = await api.get<number[]>('/things')
        return res.data
      }
    `)
    expect(found.map((f) => f.name)).toEqual(['listThings'])
    expect(found[0].validators).toEqual([])
  })

  it('ignores the same text inside a comment', () => {
    // A text-based detector reports one violation here. This one must report
    // none: there is no call, only a description of one.
    const found = scanFixture(`
      /**
       * This endpoint used to be:
       *   const res = await api.get<number[]>('/things')
       *   return res.data
       */
      export function notAnEndpoint(): number[] {
        return [1, 2, 3]
      }
    `)
    expect(found).toEqual([])
  })

  it('does not flag an already-wrapped endpoint', () => {
    const found = scanFixture(`
      export async function listThings(): Promise<number[]> {
        const res = await api.get('/things')
        return expectArray<number>(res.data)
      }
    `)
    expect(found.map((f) => f.name)).toEqual(['listThings'])
    expect(found[0].validators).toEqual(['expectArray'])
  })

  it('does not flag a non-array endpoint', () => {
    const found = scanFixture(`
      export async function getThing(): Promise<{ id: string }> {
        const res = await api.get<{ id: string }>('/thing')
        return res.data
      }
    `)
    expect(found).toEqual([])
  })

  it('sees through readonly arrays and an inferred return type', () => {
    // The three spellings the checker unifies and a text scan does not.
    const found = scanFixture(`
      export async function a(): Promise<ReadonlyArray<number>> {
        return (await api.get<number[]>('/a')).data
      }
      export const b = async () => (await api.get<number[]>('/b')).data
      export async function c(): Promise<readonly number[]> {
        return (await api.get<number[]>('/c')).data
      }
    `)
    expect(found.map((f) => f.name).sort()).toEqual(['a', 'b', 'c'])
  })

  it('follows validation one hop into a local helper', () => {
    const found = scanFixture(`
      function unwrap<T>(raw: unknown): T[] {
        if (Array.isArray(raw)) return raw as T[]
        return expectArray<T>(raw)
      }
      export async function listThings(): Promise<number[]> {
        return unwrap<number>((await api.get('/things')).data)
      }
    `)
    expect(found.map((f) => f.name)).toContain('listThings')
    expect(found.find((f) => f.name === 'listThings')!.validators.length).toBeGreaterThan(0)
  })
})
