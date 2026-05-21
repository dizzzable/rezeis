// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportsPage from './imports-page'
import { importsApi } from './imports-api'
import { renderWithProviders } from '@/test/test-utils'

function expectNoImportSensitiveLeaks(container: HTMLElement, values: readonly string[]): void {
  for (const value of values) {
    expect(container).not.toHaveTextContent(value)
    expect(container.querySelector(`a[href*="${value}"]`)).not.toBeInTheDocument()
    for (const control of Array.from(container.querySelectorAll('input, textarea, select'))) {
      expect((control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value).not.toContain(value)
    }
  }
}
describe.skip('ImportsPage', () => {
  afterEach(() => {
    cleanup()
    cleanup()
    cleanup()
    cleanup()
    cleanup()
    cleanup()
    cleanup()
    cleanup()
    cleanup()
    cleanup()
    vi.restoreAllMocks()
  })

  it('runs a dry-run preview without commit controls', async () => {
    vi.spyOn(importsApi, 'listBatches').mockResolvedValue([
      {
        id: 'batch-1',
        adminUserId: 'admin-1',
        sourceType: 'CSV',
        status: 'DRY_RUN',
        totalRows: 2,
        acceptedRows: 1,
        rejectedRows: 1,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
    ])
    vi.spyOn(importsApi, 'getBatch').mockResolvedValue({
      id: 'batch-1',
      adminUserId: 'admin-1',
      sourceType: 'CSV',
      status: 'DRY_RUN',
      totalRows: 2,
      acceptedRows: 1,
      rejectedRows: 1,
      writesPerformed: false,
      createdAt: '2026-04-24T12:00:00.000Z',
      validationErrors: [
        {
          rowNumber: 2,
          code: 'MISSING_IDENTIFIER',
          message: 'Row does not contain a supported identifier field.',
        },
      ],
      previewRows: [
        {
          rowNumber: 1,
          fields: ['email', 'username'],
          identifierPresent: true,
        },
      ],
      stagingRows: [
        {
          rowNumber: 1,
          status: 'ACCEPTED',
          identifiers: { email: 'user@example.com' },
          fields: ['email', 'username'],
          errors: [],
        },
        {
          rowNumber: 2,
          status: 'REJECTED',
          identifiers: {},
          fields: ['email'],
          errors: ['MISSING_IDENTIFIER'],
        },
      ],
    })
    vi.spyOn(importsApi, 'getCommitReadiness').mockResolvedValue({
      batchId: 'batch-1',
      isReady: false,
      reason: 'Batch has validation blockers. Commit remains disabled in this phase.',
      commitEnabled: false,
      checks: [
        { code: 'BATCH_STATUS_DRY_RUN', passed: true, message: 'Batch is still a dry-run batch.' },
        { code: 'NO_REJECTED_ROWS', passed: false, message: 'Rejected rows must be resolved before future commit.' },
      ],
    })
    vi.spyOn(importsApi, 'getRollbackReadiness').mockResolvedValue({
      batchId: 'batch-1',
      isReady: false,
      rollbackEnabled: false,
      reason: 'Created-user identifiers are not persisted for undo yet.',
      checks: [
        { code: 'ROLLBACK_IDENTIFIER_TRAIL_PRESENT', passed: false, message: 'Created user identifiers must be persisted before rollback can be enabled.' },
      ],
    })
    vi.spyOn(importsApi, 'dryRun').mockResolvedValue({
      batch: {
        id: 'batch-1',
        adminUserId: 'admin-1',
        sourceType: 'CSV',
        status: 'DRY_RUN',
        totalRows: 2,
        acceptedRows: 1,
        rejectedRows: 1,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
      result: {
        sourceType: 'CSV',
        totalRows: 2,
        acceptedRows: 1,
        rejectedRows: 1,
        validationErrors: [
          {
            rowNumber: 2,
            code: 'MISSING_IDENTIFIER',
            message: 'Row does not contain a supported identifier field.',
          },
        ],
        previewRows: [
          {
            rowNumber: 1,
            fields: ['email', 'username'],
            identifierPresent: true,
          },
          {
            rowNumber: 2,
            fields: ['email', 'username'],
            identifierPresent: false,
          },
        ],
        writesPerformed: false,
      },
    })

    const { container } = renderWithProviders(<ImportsPage />)

    expect(await screen.findByText('Import dry-run history')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run dry-run' })).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Import actions mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))
    expect(screen.getByRole('dialog', { name: 'Confirm import action' })).toBeInTheDocument()
    expect(importsApi.dryRun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))

    await waitFor(() => {
      expect(importsApi.dryRun).toHaveBeenCalledWith({
        sourceType: 'CSV',
        content: 'email,username\nuser@example.com,user',
      })
    })

    expect(await screen.findByText('Writes performed: false')).toBeInTheDocument()
    expect(await screen.findByText('Row 2: MISSING_IDENTIFIER')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect details' }))
    expect(await screen.findByText('Import batch detail')).toBeInTheDocument()
    expect(await screen.findByText('Stored preview field counts')).toBeInTheDocument()
    expect(await screen.findByText('Staging rows')).toBeInTheDocument()
    expect(await screen.findByText('Row 1: ACCEPTED · 1 identifier keys hidden · 0 issues hidden')).toBeInTheDocument()
    expect(await screen.findByText('Commit readiness checklist')).toBeInTheDocument()
    expect(await screen.findByText('Commit enabled: false')).toBeInTheDocument()
    expect(await screen.findByText(/NO_REJECTED_ROWS/)).toBeInTheDocument()
    expectNoImportSensitiveLeaks(container, [
      'Batch has validation blockers. Commit remains disabled in this phase.',
      'Batch is still a dry-run batch.',
      'Rejected rows must be resolved before future commit.',
    ])
    expect(screen.queryByRole('button', { name: /commit/i })).not.toBeInTheDocument()
  })

  it('shows rolled-back batches without commit or rollback controls', async () => {
    vi.spyOn(importsApi, 'listBatches').mockResolvedValue([
      {
        id: 'batch-rolled-back',
        adminUserId: 'admin-1',
        sourceType: 'CSV',
        status: 'ROLLED_BACK',
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
    ])
    vi.spyOn(importsApi, 'getBatch').mockResolvedValue({
      id: 'batch-rolled-back',
      adminUserId: 'admin-1',
      sourceType: 'CSV',
      status: 'ROLLED_BACK',
      totalRows: 1,
      acceptedRows: 1,
      rejectedRows: 0,
      writesPerformed: false,
      createdAt: '2026-04-24T12:00:00.000Z',
      validationErrors: [],
      previewRows: [],
      stagingRows: [],
    })
    vi.spyOn(importsApi, 'getCommitReadiness').mockResolvedValue({
      batchId: 'batch-rolled-back',
      isReady: false,
      commitEnabled: false,
      reason: 'Batch is already rolled back.',
      checks: [],
    })
    vi.spyOn(importsApi, 'getRollbackReadiness').mockResolvedValue({
      batchId: 'batch-rolled-back',
      isReady: false,
      rollbackEnabled: false,
      reason: 'Batch is already rolled back.',
      checks: [],
    })
    vi.spyOn(importsApi, 'dryRun').mockResolvedValue({
      batch: {
        id: 'batch-new',
        adminUserId: 'admin-1',
        sourceType: 'CSV',
        status: 'DRY_RUN',
        totalRows: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
      result: { sourceType: 'CSV', totalRows: 0, acceptedRows: 0, rejectedRows: 0, validationErrors: [], previewRows: [], writesPerformed: false },
    })

    renderWithProviders(<ImportsPage />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Inspect details' })).at(-1) as HTMLElement)
    expect(await screen.findByText('Rollback controls are hidden because this batch is already rolled back.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /commit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /rollback created users/i })).not.toBeInTheDocument()
  })

  it('requires confirmation for enabled commit and rollback actions without exposing raw batch ids or readiness prose', async () => {
    const commitBatchSpy = vi.spyOn(importsApi, 'commitBatch').mockResolvedValue({
      batchId: 'raw-import-batch-id-001',
      status: 'COMMITTED',
      committed: true,
      writesPerformed: true,
      target: 'STAGING_LOCK',
      createdUsers: 7,
      checkedAt: '2026-04-24T12:30:00.000Z',
    })
    const rollbackBatchSpy = vi.spyOn(importsApi, 'rollbackBatch').mockResolvedValue({
      batchId: 'raw-import-batch-id-002',
      status: 'ROLLED_BACK',
      rolledBack: true,
      deletedUsers: 9,
      checkedAt: '2026-04-24T12:35:00.000Z',
    })
    vi.spyOn(importsApi, 'listBatches').mockResolvedValue([
      {
        id: 'raw-import-batch-id-001',
        adminUserId: 'raw-admin-id-001',
        sourceType: 'CSV',
        status: 'DRY_RUN',
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
      {
        id: 'raw-import-batch-id-002',
        adminUserId: 'raw-admin-id-002',
        sourceType: 'CSV',
        status: 'COMMITTED',
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        writesPerformed: true,
        createdAt: '2026-04-24T12:10:00.000Z',
      },
    ])
    vi.spyOn(importsApi, 'getBatch').mockImplementation(async (batchId) => {
      const isCommittedBatch = batchId === 'raw-import-batch-id-002'
      return {
        id: batchId,
        adminUserId: isCommittedBatch ? 'raw-admin-id-002' : 'raw-admin-id-001',
        sourceType: 'CSV',
        status: isCommittedBatch ? 'COMMITTED' : 'DRY_RUN',
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        writesPerformed: isCommittedBatch,
        createdAt: '2026-04-24T12:00:00.000Z',
        validationErrors: [],
        previewRows: [{ rowNumber: 1, fields: ['email', 'raw_sensitive_column'], identifierPresent: true }],
        stagingRows: [{ rowNumber: 1, status: 'ACCEPTED', identifiers: { email: 'raw-user@example.test' }, fields: ['email'], errors: [] }],
      }
    })
    vi.spyOn(importsApi, 'getCommitReadiness').mockImplementation(async (batchId) => {
      const isDryRunBatch = batchId === 'raw-import-batch-id-001'
      return {
        batchId,
        isReady: isDryRunBatch,
        commitEnabled: isDryRunBatch,
        reason: 'raw backend commit reason with raw-user@example.test',
        checks: [{ code: isDryRunBatch ? 'READY_FOR_STAGING_LOCK' : 'ALREADY_COMMITTED', passed: isDryRunBatch, message: 'raw commit check message with raw-import-batch-id-001' }],
      }
    })
    vi.spyOn(importsApi, 'getRollbackReadiness').mockImplementation(async (batchId) => {
      const isCommittedBatch = batchId === 'raw-import-batch-id-002'
      return {
        batchId,
        isReady: isCommittedBatch,
        rollbackEnabled: isCommittedBatch,
        reason: 'raw backend rollback reason with raw-created-user-id-001',
        checks: [{ code: isCommittedBatch ? 'ROLLBACK_LEDGER_READY' : 'ROLLBACK_SOURCE_NOT_COMMITTED', passed: isCommittedBatch, message: 'raw rollback check message with raw-created-user-id-001' }],
      }
    })
    vi.spyOn(importsApi, 'dryRun').mockResolvedValue({
      batch: {
        id: 'raw-import-batch-id-003',
        adminUserId: 'raw-admin-id-001',
        sourceType: 'CSV',
        status: 'DRY_RUN',
        totalRows: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
      result: { sourceType: 'CSV', totalRows: 0, acceptedRows: 0, rejectedRows: 0, validationErrors: [], previewRows: [], writesPerformed: false },
    })

    const { container } = renderWithProviders(<ImportsPage />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Inspect details' }))[0])
    expect(await screen.findByText('Commit enabled: true')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit staging batch' })).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Import actions mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Commit staging batch' }))
    expect(screen.getByRole('dialog', { name: 'Confirm import action' })).toBeInTheDocument()
    expect(commitBatchSpy).not.toHaveBeenCalled()
    expectNoImportSensitiveLeaks(container, [
      'raw-import-batch-id-001',
      'raw-import-batch-id-002',
      'raw-import-batch-id-003',
      'raw-admin-id-001',
      'raw-admin-id-002',
      'raw_sensitive_column',
      'raw-user@example.test',
      'raw backend commit reason',
      'raw commit check message',
      'raw-created-user-id-001',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(commitBatchSpy).toHaveBeenCalledWith('raw-import-batch-id-001', 'STAGING_LOCK'))
    expect(await screen.findByText('Commit result recorded. Target and created-user details hidden.')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('created users 7')
    expect(container).not.toHaveTextContent('business writes true')

    fireEvent.click(screen.getByRole('button', { name: 'Create email users' }))
    expect(screen.getByRole('dialog', { name: 'Confirm import action' })).toBeInTheDocument()
    expect(commitBatchSpy).not.toHaveBeenCalledWith('raw-import-batch-id-001', 'CREATE_EMAIL_USERS')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(commitBatchSpy).toHaveBeenCalledWith('raw-import-batch-id-001', 'CREATE_EMAIL_USERS'))
    expect(container).not.toHaveTextContent('created users 7')
    expectNoImportSensitiveLeaks(container, [
      'raw-import-batch-id-001',
      'raw-admin-id-001',
      'raw_sensitive_column',
      'raw-user@example.test',
      'raw backend commit reason',
      'raw commit check message',
    ])

    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect details' })[1])
    expect(await screen.findByText('Rollback enabled: true')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rollback created users' }))
    expect(screen.getByRole('dialog', { name: 'Confirm import action' })).toBeInTheDocument()
    expect(rollbackBatchSpy).not.toHaveBeenCalled()
    expectNoImportSensitiveLeaks(container, [
      'raw-import-batch-id-001',
      'raw-import-batch-id-002',
      'raw-import-batch-id-003',
      'raw-admin-id-001',
      'raw-admin-id-002',
      'raw_sensitive_column',
      'raw-user@example.test',
      'raw backend rollback reason',
      'raw rollback check message',
      'raw-created-user-id-001',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(rollbackBatchSpy).toHaveBeenCalledWith('raw-import-batch-id-002'))
    expect(await screen.findByText('Rollback result recorded. Deleted-user details hidden.')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('deleted users 9')
  })

  it('uses generic bounded copy for import query and mutation errors', async () => {
    const rawErrors = [
      'raw dry-run backend error with raw-import-batch-error-001',
      'raw batches backend error with raw-import-batch-error-002',
      'raw detail backend error with raw-import-batch-error-003',
    ]
    vi.spyOn(importsApi, 'listBatches').mockResolvedValue([
      {
        id: 'visible-error-batch',
        adminUserId: 'raw-admin-error-id',
        sourceType: 'CSV',
        status: 'DRY_RUN',
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
    ])
    vi.spyOn(importsApi, 'dryRun').mockRejectedValue(new Error(rawErrors[0]))
    vi.spyOn(importsApi, 'getBatch').mockRejectedValue(new Error(rawErrors[2]))
    vi.spyOn(importsApi, 'getCommitReadiness').mockRejectedValue(new Error('raw commit readiness backend error with raw-import-batch-error-004'))
    vi.spyOn(importsApi, 'commitBatch').mockRejectedValue(new Error('raw commit mutation backend error with raw-import-batch-error-005'))
    vi.spyOn(importsApi, 'getRollbackReadiness').mockRejectedValue(new Error('raw rollback readiness backend error with raw-import-batch-error-006'))
    vi.spyOn(importsApi, 'rollbackBatch').mockRejectedValue(new Error('raw rollback mutation backend error with raw-import-batch-error-007'))

    const { container } = renderWithProviders(<ImportsPage />)

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'raw import operator input allowed only here' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Import actions mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to run import dry-run.')).toBeInTheDocument()

    fireEvent.click((await screen.findAllByRole('button', { name: 'Inspect details' })).at(-1) as HTMLElement)
    expect(await screen.findByText('Unable to load import batch detail.')).toBeInTheDocument()

    expectNoImportSensitiveLeaks(container, [
      'raw dry-run backend error',
      'raw detail backend error',
      'raw-import-batch-error-001',
      'raw-import-batch-error-003',
      'raw-admin-error-id',
    ])

    cleanup()
    vi.restoreAllMocks()
    vi.spyOn(importsApi, 'listBatches').mockRejectedValue(new Error(rawErrors[1]))
    const failedHistoryRender = renderWithProviders(<ImportsPage />)
    expect(await screen.findByText('Unable to load import history.')).toBeInTheDocument()
    expectNoImportSensitiveLeaks(failedHistoryRender.container, ['raw batches backend error', 'raw-import-batch-error-002'])
  })

  it('uses generic bounded copy for import readiness and mutation errors', async () => {
    vi.spyOn(importsApi, 'listBatches').mockResolvedValue([
      {
        id: 'error-dry-run-batch',
        adminUserId: 'raw-admin-error-id-commit',
        sourceType: 'CSV',
        status: 'DRY_RUN',
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        writesPerformed: false,
        createdAt: '2026-04-24T12:00:00.000Z',
      },
      {
        id: 'error-committed-batch',
        adminUserId: 'raw-admin-error-id-rollback',
        sourceType: 'CSV',
        status: 'COMMITTED',
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        writesPerformed: true,
        createdAt: '2026-04-24T13:00:00.000Z',
      },
    ])
    vi.spyOn(importsApi, 'getBatch').mockImplementation(async (batchId) => ({
      id: batchId,
      adminUserId: batchId === 'error-dry-run-batch' ? 'raw-admin-error-id-commit' : 'raw-admin-error-id-rollback',
      sourceType: 'CSV',
      status: batchId === 'error-dry-run-batch' ? 'DRY_RUN' : 'COMMITTED',
      totalRows: 1,
      acceptedRows: 1,
      rejectedRows: 0,
      writesPerformed: batchId !== 'error-dry-run-batch',
      createdAt: '2026-04-24T12:00:00.000Z',
      validationErrors: [],
      previewRows: [],
      stagingRows: [],
    }))
    vi.spyOn(importsApi, 'getCommitReadiness').mockImplementation(async (batchId) => {
      if (batchId === 'error-dry-run-batch') {
        throw new Error('raw commit readiness backend error with raw-import-batch-error-004')
      }
      return { batchId, isReady: false, commitEnabled: false, reason: 'hidden', checks: [] }
    })
    vi.spyOn(importsApi, 'getRollbackReadiness').mockImplementation(async (batchId) => {
      if (batchId === 'error-committed-batch') {
        throw new Error('raw rollback readiness backend error with raw-import-batch-error-006')
      }
      return { batchId, isReady: false, rollbackEnabled: false, reason: 'hidden', checks: [] }
    })
    vi.spyOn(importsApi, 'commitBatch').mockRejectedValue(new Error('raw commit mutation backend error with raw-import-batch-error-005'))
    vi.spyOn(importsApi, 'rollbackBatch').mockRejectedValue(new Error('raw rollback mutation backend error with raw-import-batch-error-007'))

    const { container } = renderWithProviders(<ImportsPage />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Inspect details' }))[0])
    expect(await screen.findByText('Unable to load commit readiness.')).toBeInTheDocument()
    expectNoImportSensitiveLeaks(container, ['raw commit readiness backend error', 'raw-import-batch-error-004', 'raw-admin-error-id-commit'])

    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect details' })[1])
    expect(await screen.findByText('Unable to load rollback readiness.')).toBeInTheDocument()
    expectNoImportSensitiveLeaks(container, ['raw rollback readiness backend error', 'raw-import-batch-error-006', 'raw-admin-error-id-rollback'])

    cleanup()
    vi.restoreAllMocks()
    vi.spyOn(importsApi, 'listBatches').mockResolvedValue([{ id: 'commit-enabled-batch', adminUserId: 'raw-admin-error-id-commit-mutation', sourceType: 'CSV', status: 'DRY_RUN', totalRows: 1, acceptedRows: 1, rejectedRows: 0, writesPerformed: false, createdAt: '2026-04-24T12:00:00.000Z' }])
    vi.spyOn(importsApi, 'getBatch').mockResolvedValue({ id: 'commit-enabled-batch', adminUserId: 'raw-admin-error-id-commit-mutation', sourceType: 'CSV', status: 'DRY_RUN', totalRows: 1, acceptedRows: 1, rejectedRows: 0, writesPerformed: false, createdAt: '2026-04-24T12:00:00.000Z', validationErrors: [], previewRows: [], stagingRows: [] })
    vi.spyOn(importsApi, 'getCommitReadiness').mockResolvedValue({ batchId: 'commit-enabled-batch', isReady: true, commitEnabled: true, reason: 'hidden', checks: [] })
    vi.spyOn(importsApi, 'getRollbackReadiness').mockResolvedValue({ batchId: 'commit-enabled-batch', isReady: false, rollbackEnabled: false, reason: 'hidden', checks: [] })
    vi.spyOn(importsApi, 'commitBatch').mockRejectedValue(new Error('raw commit mutation backend error with raw-import-batch-error-005'))
    const commitRender = renderWithProviders(<ImportsPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Inspect details' })).at(-1) as HTMLElement)
    expect(await screen.findByText('Commit enabled: true')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Import actions mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Commit staging batch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to commit import batch.')).toBeInTheDocument()
    expectNoImportSensitiveLeaks(commitRender.container, ['raw commit mutation backend error', 'raw-import-batch-error-005', 'raw-admin-error-id-commit-mutation'])

    cleanup()
    vi.restoreAllMocks()
    vi.spyOn(importsApi, 'listBatches').mockResolvedValue([{ id: 'rollback-enabled-batch', adminUserId: 'raw-admin-error-id-rollback-mutation', sourceType: 'CSV', status: 'COMMITTED', totalRows: 1, acceptedRows: 1, rejectedRows: 0, writesPerformed: true, createdAt: '2026-04-24T12:00:00.000Z' }])
    vi.spyOn(importsApi, 'getBatch').mockResolvedValue({ id: 'rollback-enabled-batch', adminUserId: 'raw-admin-error-id-rollback-mutation', sourceType: 'CSV', status: 'COMMITTED', totalRows: 1, acceptedRows: 1, rejectedRows: 0, writesPerformed: true, createdAt: '2026-04-24T12:00:00.000Z', validationErrors: [], previewRows: [], stagingRows: [] })
    vi.spyOn(importsApi, 'getCommitReadiness').mockResolvedValue({ batchId: 'rollback-enabled-batch', isReady: false, commitEnabled: false, reason: 'hidden', checks: [] })
    vi.spyOn(importsApi, 'getRollbackReadiness').mockResolvedValue({ batchId: 'rollback-enabled-batch', isReady: true, rollbackEnabled: true, reason: 'hidden', checks: [] })
    vi.spyOn(importsApi, 'rollbackBatch').mockRejectedValue(new Error('raw rollback mutation backend error with raw-import-batch-error-007'))
    const rollbackRender = renderWithProviders(<ImportsPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Inspect details' })).at(-1) as HTMLElement)
    expect(await screen.findByText('Rollback enabled: true')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Import actions mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rollback created users' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to rollback import batch.')).toBeInTheDocument()
    expectNoImportSensitiveLeaks(rollbackRender.container, ['raw rollback mutation backend error', 'raw-import-batch-error-007', 'raw-admin-error-id-rollback-mutation'])
  })
})
