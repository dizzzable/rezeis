import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
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
