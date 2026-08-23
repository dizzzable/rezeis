import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import ConfigPortabilityPage from './config-portability-page'
import type { ConfigImportResult, ConfigImportSummary } from './config-portability-api'

describe('ConfigPortabilityPage RBAC gating', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch config sections without config_portability:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: [] } })
    grantPermissions([])

    renderWithProviders(<ConfigPortabilityPage />)

    expect(await screen.findByText('Configuration portability access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Download JSON' })).not.toBeInTheDocument()
  })

  it('shows export sections read-only when export and import grants are absent', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: ['settings'] } })
    grantPermissions([{ resource: 'config_portability', action: 'view' }])

    renderWithProviders(<ConfigPortabilityPage />)

    expect(await screen.findByText('settings')).toBeInTheDocument()
    expect(screen.getByText('Configuration portability is read-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download JSON' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('JSON file')).not.toBeInTheDocument()
  })

  it('gives the import file control a programmatic name', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: ['settings'] } })
    grantPermissions([
      { resource: 'config_portability', action: 'view' },
      { resource: 'config_portability', action: 'import' },
    ])

    renderWithProviders(<ConfigPortabilityPage />)

    expect(await screen.findByLabelText('JSON file')).toHaveAttribute('type', 'file')
  })
})

/**
 * The summary reaching the operator
 * ─────────────────────────────────
 * The API no longer answers "created 0, updated 0, no errors" for a section it
 * never saw, and the card no longer stamps a green tick on every result. The
 * question left is which rows are worth a warning, and the API has already
 * answered it: `classifySection` attaches an error to a section that is
 * `rejected`, `failed`, or absent AFTER the operator named it — and
 * deliberately attaches none to a section that is simply not in a partial
 * file, because "turning nine informational rows into nine red errors would
 * train operators to ignore the column".
 *
 * Warning on `status` alone re-creates exactly that, one layer up: every
 * promote-one-section-from-staging restore raises an amber warning listing
 * nine sections, until a real `rejected` row looks like the same noise. These
 * tests are a set on purpose — the first proves the routine case is quiet, and
 * the rest prove the quiet is not simply the warning being gone.
 */
describe('ConfigPortabilityPage import summary', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('reads a deliberate subset restore as clean', async () => {
    // Export only `settings`, restore with nothing selected — the ordinary way
    // one section is promoted out of staging. The API calls the other sections
    // informational; the card must not overrule it.
    mockImport([
      { section: 'settings', status: 'imported', created: 0, updated: 1, skipped: 0, errors: [] },
      { section: 'roles', status: 'missing', created: 0, updated: 0, skipped: 0, errors: [] },
      { section: 'webhooks', status: 'missing', created: 0, updated: 0, skipped: 0, errors: [] },
    ], 'verified')

    await runImport()

    expect(await screen.findByText('Import result')).toBeInTheDocument()
    expect(screen.queryByText(/were not imported/)).not.toBeInTheDocument()
    // The per-row truth is untouched — the table still says which sections the
    // file did not carry. Only the verdict over the table changed.
    expect(screen.getAllByText('Not in file')).toHaveLength(2)
    expect(screen.getByText('Imported')).toBeInTheDocument()
  })

  it('warns when a section the operator actually named is absent', async () => {
    // Same `missing` status, opposite meaning: the operator asked for `roles`
    // by name and the file did not have it. The API marks that with an error,
    // and that error is what the card keys on.
    mockImport([
      {
        section: 'roles',
        status: 'missing',
        created: 0,
        updated: 0,
        skipped: 0,
        errors: ['section "roles" was requested but is absent from the payload — nothing was imported for it'],
      },
      { section: 'webhooks', status: 'imported', created: 1, updated: 0, skipped: 0, errors: [] },
    ], 'unverifiable')

    await runImport()

    expect(
      await screen.findByText(/1 section\(s\) were not imported: roles/),
    ).toBeInTheDocument()
    // A file with no manifest cannot be checked; the card must not imply it was.
    expect(screen.getByText(/no manifest in this file/)).toBeInTheDocument()
  })

  it('warns on a genuinely damaged file', async () => {
    // The case that must never be lost in the noise of routine subset
    // restores: the payload contradicts its own manifest and was refused.
    mockImport([
      {
        section: 'roles',
        status: 'rejected',
        created: 0,
        updated: 0,
        skipped: 0,
        errors: ['section "roles" contradicts the export manifest (manifest: 4 row(s), payload: 1 row(s)) — the file is damaged, nothing was imported for it'],
      },
      { section: 'webhooks', status: 'missing', created: 0, updated: 0, skipped: 0, errors: [] },
    ], 'violated')

    await runImport()

    // Only the damaged section is named — the untouched one is not padding.
    expect(
      await screen.findByText(/1 section\(s\) were not imported: roles/),
    ).toBeInTheDocument()
    expect(screen.getByText('Refused')).toBeInTheDocument()
    expect(screen.getByText(/contradicts its own manifest and is damaged/)).toBeInTheDocument()
  })

  it('leaves a genuinely complete import unadorned', async () => {
    mockImport([
      { section: 'roles', status: 'imported', created: 2, updated: 0, skipped: 0, errors: [] },
      { section: 'webhooks', status: 'imported', created: 1, updated: 0, skipped: 0, errors: [] },
    ], 'verified')

    await runImport()

    expect(await screen.findByText('Import result')).toBeInTheDocument()
    expect(screen.queryByText(/were not imported/)).not.toBeInTheDocument()
    expect(screen.queryByText('Not in file')).not.toBeInTheDocument()
    expect(screen.getByText(/checked against the manifest/)).toBeInTheDocument()
  })
})

/**
 * Exporting webhook signing secrets
 * ─────────────────────────────────
 * The API kept a deliberate opt-in for the one case that needs live secrets —
 * promoting a config to another deployment — and redacts them otherwise
 * (`admin-config-portability.controller.ts:79`, `config-export.service.ts:124`).
 * The panel never sent it. `WebhookSubscription.secret` is a non-nullable
 * `String` with no default, so a webhook row exported without it cannot be
 * CREATED on the destination: `upsertById` takes the `create` arm, Prisma
 * refuses, and the operator's migration loses the whole `webhooks` section.
 *
 * These tests therefore assert on the URL that LEAVES the panel, not on
 * whether `exportConfig` accepts an argument — a capability with no caller is
 * exactly the shape of the bug being closed, and a test that only calls the
 * function directly would reproduce it.
 *
 * The pair is deliberate. Asserting only the opt-in direction still passes if
 * the flag is sent unconditionally, which is the dangerous failure: it turns
 * every routine export — including one taken just to diff two environments —
 * back into a file full of live credentials, which is the default the API was
 * hardened to remove.
 */
describe('ConfigPortabilityPage webhook secret export opt-in', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
    // jsdom implements neither; the download is a side effect of the same
    // click, and without these the click throws before anything is asserted.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:stub'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
  })

  it('omits the flag when the operator does not opt in', async () => {
    const getSpy = mockExport()
    await renderExporter()

    await userEvent.click(await screen.findByRole('button', { name: 'Download JSON' }))

    const url = await findExportRequestUrl(getSpy)
    expect(url).not.toContain('includeWebhookSecrets')
  })

  it('sends the flag once the operator opts in', async () => {
    const getSpy = mockExport()
    await renderExporter()

    await userEvent.click(screen.getByLabelText('Include webhook signing secrets'))
    await userEvent.click(await screen.findByRole('button', { name: 'Download JSON' }))

    const url = await findExportRequestUrl(getSpy)
    expect(url).toContain('includeWebhookSecrets=true')
  })

  it('keeps the flag off the request after the operator turns the opt-in back off', async () => {
    const getSpy = mockExport()
    await renderExporter()

    const toggle = screen.getByLabelText('Include webhook signing secrets')
    await userEvent.click(toggle)
    await userEvent.click(toggle)
    await userEvent.click(await screen.findByRole('button', { name: 'Download JSON' }))

    const url = await findExportRequestUrl(getSpy)
    expect(url).not.toContain('includeWebhookSecrets')
  })

  it('still carries the selected sections alongside the flag', async () => {
    const getSpy = mockExport()
    await renderExporter()

    // One section only, so the request is a genuine subset export rather than
    // the "all sections" shape that sends no `sections` parameter at all.
    await userEvent.click(screen.getByRole('checkbox', { name: 'webhooks' }))
    await userEvent.click(screen.getByLabelText('Include webhook signing secrets'))
    await userEvent.click(await screen.findByRole('button', { name: 'Download JSON' }))

    const url = await findExportRequestUrl(getSpy)
    expect(url).toContain('sections=webhooks')
    expect(url).toContain('includeWebhookSecrets=true')
  })

  it('starts with the opt-in off and says why it exists before it is used', async () => {
    mockExport()
    await renderExporter()

    expect(screen.getByLabelText('Include webhook signing secrets')).not.toBeChecked()
    expect(screen.getByText(/migrating to another deployment/)).toBeInTheDocument()
    // The consequence of arming it is stated only once it IS armed, so the
    // routine exporter is not trained to scroll past a standing warning.
    expect(screen.queryByText(/live signing secrets in plain text/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Include webhook signing secrets'))

    expect(screen.getByText(/live signing secrets in plain text/)).toBeInTheDocument()
  })

  it('drops the flag when the grant is withdrawn after the operator armed it', async () => {
    // The toggle is state, and state outlives the control that set it. An
    // admin who arms the opt-in and then has `webhooks:edit` taken away
    // (role edited, permissions refetched) must not still be able to pull
    // live secrets with a click on a button that is still on screen.
    const getSpy = mockExport()
    await renderExporter()

    await userEvent.click(screen.getByLabelText('Include webhook signing secrets'))
    // The store lives outside React, so the revocation has to be flushed
    // before the assertions read the tree.
    act(() => {
      grantPermissions([
        { resource: 'config_portability', action: 'view' },
        { resource: 'config_portability', action: 'export' },
      ])
    })

    expect(screen.queryByLabelText('Include webhook signing secrets')).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Download JSON' }))

    const url = await findExportRequestUrl(getSpy)
    expect(url).not.toContain('includeWebhookSecrets')
  })

  it('withholds the opt-in from an exporter who may not read a live secret', async () => {
    const getSpy = mockExport()
    // `config_portability:export` but no `webhooks:edit`. The webhooks screen
    // never shows this admin a secret value (list responses carry
    // `secret: null`), so the export must not become the way around that.
    await renderExporter([
      { resource: 'config_portability', action: 'view' },
      { resource: 'config_portability', action: 'export' },
    ])

    expect(await screen.findByRole('button', { name: 'Download JSON' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Include webhook signing secrets')).not.toBeInTheDocument()
    expect(screen.getByText(/needs webhooks:edit on top of config_portability:export/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Download JSON' }))

    const url = await findExportRequestUrl(getSpy)
    expect(url).not.toContain('includeWebhookSecrets')
  })
})

/**
 * The same gap, met from the destination side: a file whose webhook rows were
 * redacted is told BEFORE the run, not discovered from a `failed` row after
 * it. A warning and not a block on purpose — a subscription that already
 * exists here imports fine without its secret, since the update arm keeps the
 * destination's own.
 */
describe('ConfigPortabilityPage import-time webhook secret warning', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('warns when a picked file carries a webhook with no secret', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: ['roles', 'webhooks'] } })
    await pickImportFile({ webhooks: [{ id: 'wh-1', name: 'ops', url: 'https://x.test' }] })

    expect(
      await screen.findByText(/1 webhook in this file has no signing secret/),
    ).toBeInTheDocument()
    // Still importable: the file may be a re-import over existing rows.
    expect(screen.getByRole('button', { name: 'Run preview' })).toBeEnabled()
  })

  it('stays quiet when every webhook row carries its secret', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: ['roles', 'webhooks'] } })
    await pickImportFile({
      webhooks: [{ id: 'wh-1', name: 'ops', url: 'https://x.test', secret: 'deadbeef' }],
    })

    expect(await screen.findByText(/Loaded config\.json/)).toBeInTheDocument()
    expect(screen.queryByText(/no signing secret/)).not.toBeInTheDocument()
  })

  it('stays quiet for a file with no webhooks section at all', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: ['roles', 'webhooks'] } })
    await pickImportFile({ roles: [{ id: 'r-1', name: 'support' }] })

    expect(await screen.findByText(/Loaded config\.json/)).toBeInTheDocument()
    expect(screen.queryByText(/no signing secret/)).not.toBeInTheDocument()
  })
})

/** Spy on `api.get`, answering the sections probe and the export separately. */
function mockExport() {
  const getSpy = vi.spyOn(api, 'get')
  const implementation = (url: string) => {
    if (url.startsWith('/admin/config/export')) {
      return Promise.resolve({
        data: { version: 1, exportedAt: '', source: 'rezeis-admin', sections: {} },
      })
    }
    return Promise.resolve({ data: { sections: ['roles', 'webhooks'] } })
  }
  getSpy.mockImplementation(implementation as never)
  return getSpy
}

/** The URL the panel actually put on the wire for the export. */
async function findExportRequestUrl(
  getSpy: ReturnType<typeof mockExport>,
): Promise<string> {
  let url: string | undefined
  await waitFor(() => {
    url = getSpy.mock.calls
      .map((call) => call[0])
      .filter((value): value is string => typeof value === 'string')
      .find((value) => value.startsWith('/admin/config/export'))
    expect(url).toBeDefined()
  })
  return url as string
}

async function renderExporter(
  permissions: ReadonlyArray<{ resource: string; action: RbacAction }> = [
    { resource: 'config_portability', action: 'view' },
    { resource: 'config_portability', action: 'export' },
    { resource: 'webhooks', action: 'edit' },
  ],
): Promise<void> {
  grantPermissions(permissions)
  renderWithProviders(<ConfigPortabilityPage />)
  // Wait for the section list, so the export request is the only outstanding
  // `api.get` call the assertions have to reason about.
  await screen.findByText('webhooks')
}

/** Loads a payload through the real file control. */
async function pickImportFile(sections: Record<string, unknown[]>): Promise<void> {
  grantPermissions([
    { resource: 'config_portability', action: 'view' },
    { resource: 'config_portability', action: 'import' },
  ])
  renderWithProviders(<ConfigPortabilityPage />)

  const fileInput = await screen.findByLabelText('JSON file')
  await userEvent.upload(
    fileInput,
    new File([JSON.stringify({ version: 1, sections })], 'config.json', {
      type: 'application/json',
    }),
  )
}

function mockImport(
  summaries: readonly ConfigImportSummary[],
  integrity: ConfigImportResult['integrity'],
): void {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { sections: ['roles', 'webhooks'] } })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      version: 1,
      strategy: 'overwrite',
      dryRun: false,
      integrity,
      summaries,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    } satisfies ConfigImportResult,
  })
}

/** Picks a file and applies the import through the real controls. */
async function runImport(): Promise<void> {
  grantPermissions([
    { resource: 'config_portability', action: 'view' },
    { resource: 'config_portability', action: 'import' },
  ])
  renderWithProviders(<ConfigPortabilityPage />)

  const fileInput = await screen.findByLabelText('JSON file')
  const file = new File(
    [JSON.stringify({ version: 1, sections: { webhooks: [{ id: 'wh-1' }] } })],
    'config.json',
    { type: 'application/json' },
  )
  await userEvent.upload(fileInput, file)
  // The dry-run switch defaults on; turn it off so the "Apply import" path
  // — the one an operator actually restores with — is what gets exercised.
  await userEvent.click(screen.getByLabelText('Dry run (no DB writes)'))
  await userEvent.click(await screen.findByRole('button', { name: 'Apply import' }))
}

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((permission) => `${permission.resource}:${permission.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}
