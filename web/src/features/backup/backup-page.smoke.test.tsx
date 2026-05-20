// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BackupPage from '@/features/backup/backup-page'
import { backupApi } from '@/features/backup/backup-api'
import { renderWithProviders } from '@/test/test-utils'

function expectNoSensitiveValue(container: HTMLElement, value: string): void {
  expect(container).not.toHaveTextContent(value)
  expect(container.querySelector(`a[href*="${value}"]`)).not.toBeInTheDocument()
  const controls = Array.from(container.querySelectorAll('input, textarea, select'))
  for (const control of controls) {
    expect((control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value).not.toContain(value)
  }
}
describe.skip('BackupPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders read-only backup manifest with export disabled', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.spyOn(backupApi, 'getManifest').mockResolvedValue({
      generatedAt: '2026-04-24T12:00:00.000Z',
      exportEnabled: false,
      restoreEnabled: false,
      domains: [
        { domain: 'users', status: 'REQUIRES_RESTORE_DESIGN', rowCount: 10, containsSensitiveData: true, notes: ['Contains identity/contact data. Export requires redaction policy.'] },
        { domain: 'broadcasts', status: 'READY_FOR_EXPORT_DESIGN', rowCount: 2, containsSensitiveData: false, notes: ['Message payload export requires operator review.'] },
      ],
    })
    vi.spyOn(backupApi, 'getExportPolicy').mockResolvedValue({
      generatedAt: '2026-04-24T12:00:00.000Z',
      exportEndpointEnabled: false,
      restoreEnabled: false,
      domains: [
        {
          domain: 'users',
          exportAllowed: false,
          includedFields: ['id', 'role'],
          redactedFields: ['email', 'telegramId'],
          notes: ['User export requires explicit redaction and restore identity policy.'],
        },
      ],
    })
    const downloadImportsSpy = vi.spyOn(backupApi, 'downloadImports').mockResolvedValue(new Blob(['{}'], { type: 'application/json' }))
    const restoreDryRunSpy = vi.spyOn(backupApi, 'dryRunRestoreImports').mockResolvedValue({
      domain: 'imports',
      writesPerformed: false,
      isValid: true,
      batches: 1,
      stagingRows: 2,
      rollbackItems: 1,
      errors: [{ code: 'RESTORE_ERROR_CODE', message: 'raw restore error leaked user raw-restore-user-id-001' }],
    })
    vi.spyOn(backupApi, 'exportImports').mockResolvedValue({
      generatedAt: '2026-04-24T12:00:00.000Z',
      domain: 'imports',
      restoreEnabled: false,
      rawContentIncluded: false,
      batches: [
        {
          id: 'raw-export-batch-id-001',
          sourceType: 'CSV',
          status: 'COMMITTED',
          totalRows: 1,
          acceptedRows: 1,
          rejectedRows: 0,
          writesPerformed: true,
          createdAt: '2026-04-24T12:00:00.000Z',
          stagingRows: [{ rowNumber: 1, status: 'ACCEPTED', fields: ['raw_export_field_name'], identifierKeys: ['raw_export_identifier_key'], errors: ['raw export row error'] }],
          rollbackItems: [{ userId: 'raw-export-user-id-001', email: 'raw-export-user@example.test', status: 'PENDING', rolledBackAt: null }],
        },
      ],
    })
    vi.spyOn(backupApi, 'listExportAudits').mockResolvedValue({
      generatedAt: '2026-04-24T12:00:00.000Z',
      items: [
        {
          id: 'audit-1',
          action: 'DOWNLOAD_IMPORTS_BACKUP_EXPORT',
          adminActorPresent: true,
          domain: 'imports',
          batches: 1,
          rawContentIncluded: false,
          restoreEnabled: false,
          createdAt: '2026-04-24T12:00:00.000Z',
        },
      ],
    })
    vi.spyOn(backupApi, 'getRestorePolicy').mockResolvedValue({
      generatedAt: '2026-04-24T12:00:00.000Z',
      restoreEnabled: false,
      blockers: [
        { code: 'RESTORE_DRY_RUN_REQUIRED', message: 'raw restore policy blocker prose raw-policy-user-id-001' },
      ],
      requiredFutureSlices: ['raw future slice prose raw-future-slice-001'],
    })
    vi.spyOn(backupApi, 'listRestoreBatches').mockResolvedValue([
      {
        id: 'raw-restore-batch-id-001',
        domain: 'imports',
        status: 'DRY_RUN',
        isValid: true,
        batchCount: 1,
        stagingRowCount: 2,
        rollbackItemCount: 1,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
    ])
    vi.spyOn(backupApi, 'getRestoreBatch').mockResolvedValue({
      id: 'raw-restore-batch-id-001',
      domain: 'imports',
      status: 'DRY_RUN',
      isValid: true,
      batchCount: 1,
      stagingRowCount: 2,
      rollbackItemCount: 1,
      writesPerformed: false,
      createdAt: '2026-04-24T12:00:00.000Z',
      errors: [{ code: 'RESTORE_BATCH_ERROR', message: 'raw restore batch detail error raw-batch-user-id-001' }],
    })
    vi.spyOn(backupApi, 'getRestoreCommitReadiness').mockResolvedValue({
      batchId: 'raw-restore-batch-id-001',
      isReady: false,
      commitEnabled: false,
      checks: [
        { code: 'RESTORE_EXECUTOR_NOT_IMPLEMENTED', passed: false, severity: 'BLOCKER', message: 'raw restore readiness prose raw-readiness-user-id-001' },
      ],
    })
    vi.spyOn(backupApi, 'getRestoreExecutorGate').mockResolvedValue({
      generatedAt: '2026-04-24T12:00:00.000Z',
      executorEnabled: false,
      domains: [
        { domain: 'imports', firstSupportedTarget: 'raw executor target prose', blockers: ['raw executor blocker prose'], requiredControls: ['raw executor control prose'] },
      ],
    })

    const { container } = renderWithProviders(<BackupPage />)

    expect(await screen.findByText('Backup manifest')).toBeInTheDocument()
    expect(await screen.findByText('Export enabled: false')).toBeInTheDocument()
    expect(await screen.findByText('Export redaction policy')).toBeInTheDocument()
    expect(await screen.findByText('Export endpoint enabled: false')).toBeInTheDocument()
    expect((await screen.findAllByText('2 fields hidden')).length).toBeGreaterThan(0)
    expect(await screen.findByText('Imports export preview')).toBeInTheDocument()
    expect(await screen.findByText('1 batches')).toBeInTheDocument()
    expect(await screen.findByText('Raw content included: false')).toBeInTheDocument()
    const downloadButton = await screen.findByRole('button', { name: 'Download imports JSON' })
    expect(downloadButton).toBeDisabled()
    fireEvent.click(downloadButton)
    expect(downloadImportsSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Backup actions mode'))
    fireEvent.click(downloadButton)
    expect(downloadImportsSpy).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'Confirm backup action' })).toBeInTheDocument()
    expectNoSensitiveValue(container, 'raw-export-batch-id-001')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(downloadImportsSpy).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Export download audit history')).toBeInTheDocument()
    expect(await screen.findByText('DOWNLOAD_IMPORTS_BACKUP_EXPORT')).toBeInTheDocument()
    expect(await screen.findByText('Restore policy gate')).toBeInTheDocument()
    expect(await screen.findByText('RESTORE_DRY_RUN_REQUIRED')).toBeInTheDocument()
    expect(await screen.findByText('Restore dry-run parser')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Paste imports backup JSON…'), { target: { value: '{"domain":"imports","raw":"raw-pasted-restore-content-001"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run restore dry-run' }))
    expect(restoreDryRunSpy).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'Confirm backup action' })).toBeInTheDocument()
    expect(screen.queryByText('raw-pasted-restore-content-001')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(restoreDryRunSpy).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Restore dry-run result')).toBeInTheDocument()
    expect(await screen.findByText('Valid true · batches 1 · staging rows 2 · rollback items 1')).toBeInTheDocument()
    expect(await screen.findByText('RESTORE_ERROR_CODE: message hidden')).toBeInTheDocument()
    expect(await screen.findByText('Restore dry-run history')).toBeInTheDocument()
    expect(await screen.findByText('Restore batch')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect restore batch' }))
    expect(await screen.findByText('Restore batch detail')).toBeInTheDocument()
    expect(await screen.findByText('Restore commit readiness')).toBeInTheDocument()
    expect(await screen.findByText('Restore executor gate')).toBeInTheDocument()
    expect(await screen.findByText('RESTORE_BATCH_ERROR: message hidden')).toBeInTheDocument()
    expect((await screen.findAllByText('Restore enabled: false')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('users')).length).toBeGreaterThan(0)

    for (const sensitive of [
      'raw-export-batch-id-001',
      'raw_export_field_name',
      'raw_export_identifier_key',
      'raw export row error',
      'raw-export-user-id-001',
      'raw-export-user@example.test',
      'raw-policy-user-id-001',
      'raw future slice prose raw-future-slice-001',
      'raw-restore-batch-id-001',
      'raw-batch-user-id-001',
      'raw-readiness-user-id-001',
      'raw executor target prose',
      'raw executor blocker prose',
      'raw executor control prose',
      'raw restore error leaked user raw-restore-user-id-001',
    ]) {
      expectNoSensitiveValue(container, sensitive)
    }
  })

  it('uses generic bounded copy for backup query and mutation errors', async () => {
    vi.spyOn(backupApi, 'getManifest').mockRejectedValue(new Error('raw manifest backend error raw-backup-error-001'))
    vi.spyOn(backupApi, 'getRestoreExecutorGate').mockRejectedValue(new Error('raw executor gate backend error raw-backup-error-002'))
    vi.spyOn(backupApi, 'getExportPolicy').mockRejectedValue(new Error('raw export policy backend error raw-backup-error-003'))
    vi.spyOn(backupApi, 'exportImports').mockRejectedValue(new Error('raw imports export query backend error raw-backup-error-004'))
    vi.spyOn(backupApi, 'listExportAudits').mockRejectedValue(new Error('raw export audits backend error raw-backup-error-005'))
    vi.spyOn(backupApi, 'getRestorePolicy').mockRejectedValue(new Error('raw restore policy backend error raw-backup-error-006'))
    vi.spyOn(backupApi, 'listRestoreBatches').mockResolvedValue([])

    const { container } = renderWithProviders(<BackupPage />)

    expect(await screen.findByText('Unable to load backup manifest.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to load restore executor gate.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to load export policy.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to load imports export preview.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to load export audit history.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to load restore policy.')).toBeInTheDocument()
    for (const sensitive of [
      'raw manifest backend error',
      'raw executor gate backend error',
      'raw export policy backend error',
      'raw imports export query backend error',
      'raw export audits backend error',
      'raw restore policy backend error',
      'raw-backup-error-001',
      'raw-backup-error-002',
      'raw-backup-error-003',
      'raw-backup-error-004',
      'raw-backup-error-005',
      'raw-backup-error-006',
    ]) {
      expectNoSensitiveValue(container, sensitive)
    }

    cleanup()
    vi.restoreAllMocks()

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.spyOn(backupApi, 'getManifest').mockResolvedValue({ generatedAt: '2026-04-24T12:00:00.000Z', exportEnabled: false, restoreEnabled: false, domains: [] })
    vi.spyOn(backupApi, 'getRestoreExecutorGate').mockResolvedValue({ generatedAt: '2026-04-24T12:00:00.000Z', executorEnabled: false, domains: [] })
    vi.spyOn(backupApi, 'getExportPolicy').mockResolvedValue({ generatedAt: '2026-04-24T12:00:00.000Z', exportEndpointEnabled: false, restoreEnabled: false, domains: [] })
    vi.spyOn(backupApi, 'exportImports').mockResolvedValue({ generatedAt: '2026-04-24T12:00:00.000Z', domain: 'imports', restoreEnabled: false, rawContentIncluded: false, batches: [] })
    vi.spyOn(backupApi, 'listExportAudits').mockResolvedValue({ generatedAt: '2026-04-24T12:00:00.000Z', items: [] })
    vi.spyOn(backupApi, 'getRestorePolicy').mockResolvedValue({ generatedAt: '2026-04-24T12:00:00.000Z', restoreEnabled: false, blockers: [], requiredFutureSlices: [] })
    vi.spyOn(backupApi, 'listRestoreBatches').mockResolvedValue([])
    vi.spyOn(backupApi, 'downloadImports').mockRejectedValue(new Error('raw download mutation backend error raw-backup-error-007'))
    vi.spyOn(backupApi, 'dryRunRestoreImports').mockRejectedValue(new Error('raw restore dry-run mutation backend error raw-backup-error-008'))

    const mutationRender = renderWithProviders(<BackupPage />)
    const downloadButton = await screen.findByRole('button', { name: 'Download imports JSON' })
    fireEvent.click(screen.getByLabelText('Backup actions mode'))
    fireEvent.click(downloadButton)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Unable to download imports export.')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Paste imports backup JSON…'), { target: { value: '{"domain":"imports"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run restore dry-run' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Unable to run restore dry-run.')).toBeInTheDocument()
    for (const sensitive of [
      'raw download mutation backend error',
      'raw restore dry-run mutation backend error',
      'raw-backup-error-007',
      'raw-backup-error-008',
    ]) {
      expectNoSensitiveValue(mutationRender.container, sensitive)
    }
  })
})
