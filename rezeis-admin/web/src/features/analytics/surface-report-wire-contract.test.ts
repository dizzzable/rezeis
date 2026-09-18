/**
 * THE USAGE-SURFACE REPORT, READ OFF BOTH SIDES.
 *
 * The card's mocks answer with bodies written from `UsageSurfaceReport`, so they
 * stay green against a server that renamed a field: the SPA type and the mock
 * change together, and the backend never hears of it. This file holds the two
 * declarations to each other instead — the backend's interfaces read with the
 * TypeScript parser, never imported (they sit in a module tree that imports
 * Nest, which CI's web-quality job does not install) — plus the route that
 * serves the body and the one value of it both sides must spell the same way.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AxiosResponse } from 'axios'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { getSurfaceAnalytics, readSurfaceReport, type UsageSurfaceReport } from './analytics-api'
import { PWA_INSTALL_OS_UNKNOWN } from './surface-palette'

const HERE = dirname(fileURLToPath(import.meta.url))
const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

const BACKEND = resolve(HERE, '../../../../src/modules/business-analytics')
const TYPES = parse(resolve(BACKEND, 'interfaces/business-analytics.types.ts'))
const SERVICE = parse(resolve(BACKEND, 'services/business-analytics.service.ts'))
const CONTROLLER = parse(resolve(BACKEND, 'controllers/admin-analytics.controller.ts'))
const UTIL = parse(resolve(BACKEND, 'utils/usage-surface-report.util.ts'))
const SPA = parse(resolve(HERE, 'analytics-api.ts'))

/** An interface as `field → type`, `readonly` dropped, the backend's `…Interface` names read as the SPA's. */
function declared(source: ts.SourceFile, name: string): Record<string, string> {
  const found = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (found === undefined) throw new Error(`${name} is not declared in ${source.fileName} — it moved or was renamed`)
  return Object.fromEntries(
    found.members.map((member) => {
      if (!ts.isPropertySignature(member) || member.type === undefined) {
        throw new Error(`${name}: a member that is not a plain property — ${member.getText(source)}`)
      }
      const type = member.type.getText(source).replace(/\s+/g, ' ').replace(/(\w+)Interface\b/g, '$1')
      return [`${member.name.getText(source)}${member.questionToken ? '?' : ''}`, type]
    }),
  )
}

describe('the body of GET /admin/analytics/surfaces', () => {
  it('is declared field for field the same on the server and in the panel', () => {
    const server = declared(TYPES, 'UsageSurfaceReportInterface')
    const panel = declared(SPA, 'UsageSurfaceReport')

    expect(Object.keys(server).sort(), 'the fields the server sends').toEqual(Object.keys(panel).sort())
    expect(panel).toEqual(server)
    expect(declared(SPA, 'SurfaceCount')).toEqual(declared(TYPES, 'SurfaceCountInterface'))
    // Anchors: the comparison above is about something.
    expect(server).toMatchObject({ pwaInstalls: 'number', pwaInstallsByOs: 'readonly SurfaceCount[]' })
    expect(Object.keys(server)).toHaveLength(8)
  })

  it('is what the route that the panel calls returns', async () => {
    const controller = CONTROLLER.getText()
    const route = /@Get\('admin\/analytics\/surfaces'\)[\s\S]*?public (\w+)\(\)\s*\{\s*return this\.analyticsService\.(\w+)\(\);/.exec(controller)
    expect(route, 'the surfaces route or its handler moved').not.toBeNull()
    expect(route?.[2]).toBe('getSurfaceAnalytics')
    expect(SERVICE.getText()).toMatch(/public async getSurfaceAnalytics\(\): Promise<UsageSurfaceReportInterface>/)

    const body: UsageSurfaceReport = {
      surfaces: [{ key: 'tma', count: 3 }],
      formFactors: [{ key: 'mobile', count: 3 }],
      operatingSystems: [{ key: 'ios', count: 3 }],
      pwaInstalls: 2,
      pwaInstallsByOs: [{ key: 'ios', count: 1 }, { key: PWA_INSTALL_OS_UNKNOWN, count: 1 }],
      activeLast30d: 1,
      totalTracked: 3,
      generatedAt: '2026-09-15T00:00:00.000Z',
    }
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: JSON.parse(JSON.stringify(body)) } as AxiosResponse)

    await expect(getSurfaceAnalytics()).resolves.toEqual(body)
    expect(get).toHaveBeenCalledWith('/admin/analytics/surfaces')
  })

  it('names an install with no recorded OS the same way on both sides', () => {
    expect(UTIL.getText()).toContain(`export const PWA_INSTALL_OS_UNKNOWN = '${PWA_INSTALL_OS_UNKNOWN}';`)
  })
})

describe('reading the body', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const complete = {
    surfaces: [],
    formFactors: [],
    operatingSystems: [],
    pwaInstalls: 0,
    pwaInstallsByOs: [],
    activeLast30d: 0,
    totalTracked: 0,
    generatedAt: '2026-09-15T00:00:00.000Z',
  }

  it('refuses a body from a panel that does not send installs by OS yet, rather than draw "no installs"', () => {
    const { pwaInstallsByOs: _dropped, ...older } = complete
    expect(() => readSurfaceReport(older)).toThrow()
    expect(() => readSurfaceReport({ ...complete, operatingSystems: {} })).toThrow()
    expect(() => readSurfaceReport('<!doctype html>')).toThrow()
    expect(readSurfaceReport(complete)).toEqual(complete)
  })
})
