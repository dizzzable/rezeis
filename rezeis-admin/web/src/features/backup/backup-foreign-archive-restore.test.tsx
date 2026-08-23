/**
 * Restoring an archive this deployment did not produce — from the panel.
 *
 * `backup.service.ts:423-429` refuses such a restore with a 400 whose message
 * literally instructs the caller to `re-send the request with
 * "acknowledgeForeignArchive": true`, and both restore routes accept that field
 * (`admin-backup.controller.ts:308` and `:337`). The panel could not send it:
 * `grep -rn "acknowledgeForeignArchive" web/src/` returned nothing. So the two
 * moments a restore matters most — migrating to a new server, rebuilding after
 * a failure — ended at an error telling the operator to hand-craft HTTP.
 *
 * These tests drive the page the way an operator does: click the row's restore
 * control, confirm, receive the SERVER'S ACTUAL REFUSAL TEXT, and then decide.
 * The refusal below is assembled from the real message so a wording change on
 * the server that breaks detection fails here rather than in production.
 *
 * The detection cannot key off a machine-readable code: this refusal is a plain
 * `BadRequestException`, and `AdminSafeExceptionFilter` only forwards a `code`
 * for its `SAFE_PRODUCT_CODES` allowlist, which this is not on. The message is
 * the whole contract, which is exactly why it is reproduced verbatim here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, type AxiosResponse } from 'axios'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import BackupPage from './backup-page'

/**
 * `backup.service.ts:423-429`, reproduced. `describeForeignReason('unstamped')`
 * supplies the leading clause (`backup-provenance.util.ts:242-243`).
 */
const FOREIGN_ARCHIVE_MESSAGE =
  'Refusing to restore an archive this deployment cannot verify: the archive carries no ' +
  'provenance stamp (another deployment, or taken before stamping existed). ' +
  'Restoring it runs whatever SQL it contains as the database owner, which can replace admin_users, ' +
  'roles, permissions and the IP allowlist. If this archive really is yours — a server migration, or a ' +
  'dump taken before provenance stamping existed — re-send the request with ' +
  '"acknowledgeForeignArchive": true. That path additionally requires the admins:edit permission.'

/** A 400 shaped by `AdminSafeExceptionFilter.buildResponseBody`. */
function refusal(message: string): AxiosError {
  const response = {
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config: {},
    data: {
      timestamp: '2026-08-21T09:00:00.000Z',
      path: '/api/admin/backup/restore/backup-1.sql.gz',
      requestId: null,
      statusCode: 400,
      message,
      errorCode: 'BAD_REQUEST',
      error: 'Bad Request',
    },
  } as unknown as AxiosResponse
  return new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, null, response)
}

const STORED_BACKUP = {
  id: 'backup-1',
  filename: 'backup-1.sql.gz',
  scope: 'DB',
  sizeBytes: '4096',
  checksum: null,
  deliveryChannel: 'local',
  deliveryRecipient: null,
  deliveredAt: '2026-06-03T00:00:00.000Z',
  errorMessage: null,
  createdAt: '2026-06-03T00:00:00.000Z',
}

describe('BackupPage — foreign-archive acknowledgement', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { items: [STORED_BACKUP], total: 1, limit: 50, offset: 0 },
    })
  })

  it('re-sends a stored-archive restore with the acknowledgement the server asked for', async () => {
    const user = userEvent.setup()
    const post = vi
      .spyOn(api, 'post')
      .mockRejectedValueOnce(refusal(FOREIGN_ARCHIVE_MESSAGE))
      .mockResolvedValueOnce({ data: { jobId: 'job-1', message: 'Restore job enqueued', provenance: 'foreign' } })
    grantPermissions([
      { resource: 'backups', action: 'view' },
      { resource: 'backups', action: 'run' },
      { resource: 'admins', action: 'edit' },
    ])

    renderWithProviders(<BackupPage />)

    await user.click(await screen.findByRole('button', { name: 'Restore' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore' }),
    )

    // First attempt: no acknowledgement. That is what makes the server answer.
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenNthCalledWith(1, '/admin/backup/restore/backup-1.sql.gz', {})

    // The refusal, in the server's own words, plus what confirming would do.
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText('This archive was not produced by this deployment'),
    ).toBeInTheDocument()
    expect(dialog).toHaveTextContent(/carries no provenance stamp/)
    expect(dialog).toHaveTextContent(/create or replace admin accounts/i)

    await user.click(within(dialog).getByRole('button', { name: 'Restore anyway' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post).toHaveBeenNthCalledWith(2, '/admin/backup/restore/backup-1.sql.gz', {
      acknowledgeForeignArchive: true,
    })
  })

  it('never offers the acknowledgement without admins:edit, and says why', async () => {
    const user = userEvent.setup()
    const post = vi.spyOn(api, 'post').mockRejectedValue(refusal(FOREIGN_ARCHIVE_MESSAGE))
    grantPermissions([
      { resource: 'backups', action: 'view' },
      { resource: 'backups', action: 'run' },
    ])

    renderWithProviders(<BackupPage />)

    await user.click(await screen.findByRole('button', { name: 'Restore' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore' }),
    )

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/also requires the admins:edit permission/)
    expect(within(dialog).queryByRole('button', { name: 'Restore anyway' })).not.toBeInTheDocument()

    // The panel must not be able to reach the 403 leg at all: on the upload
    // route that leg fires AFTER multer has written the whole file and leaves
    // it orphaned on disk with no BackupRecord.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('does not treat an unrelated 400 as a foreign archive', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'post').mockRejectedValue(refusal('Invalid backup filename'))
    grantPermissions([
      { resource: 'backups', action: 'view' },
      { resource: 'backups', action: 'run' },
      { resource: 'admins', action: 'edit' },
    ])

    renderWithProviders(<BackupPage />)

    await user.click(await screen.findByRole('button', { name: 'Restore' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore' }),
    )

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(
      screen.queryByText('This archive was not produced by this deployment'),
    ).not.toBeInTheDocument()
  })

  it('re-sends the SAME uploaded file with the acknowledgement, without a re-pick', async () => {
    const user = userEvent.setup()
    const post = vi
      .spyOn(api, 'post')
      .mockRejectedValueOnce(refusal(FOREIGN_ARCHIVE_MESSAGE))
      .mockResolvedValueOnce({ data: { jobId: 'job-2', message: 'Restore job enqueued', provenance: 'foreign' } })
    grantPermissions([
      { resource: 'backups', action: 'view' },
      { resource: 'backups', action: 'run' },
      { resource: 'admins', action: 'edit' },
    ])

    const { container } = renderWithProviders(<BackupPage />)

    await user.click(await screen.findByRole('button', { name: 'Restore from file' }))
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(picker).not.toBeNull()
    const archive = new File(['\x1f\x8b payload'], 'from-old-server.sql.gz', {
      type: 'application/gzip',
    })
    await user.upload(picker as HTMLInputElement, archive)

    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore' }),
    )
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))

    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText('This archive was not produced by this deployment'),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Restore anyway' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    // `AlertDialogAction` closes its dialog, which clears `uploadFile`. The
    // retry therefore proves the File handle survived that close — without it
    // there would be nothing left to send and the operator would have to find
    // the file on disk again.
    const retryBody = post.mock.calls[1][1] as FormData
    expect(retryBody).toBeInstanceOf(FormData)
    expect(retryBody.get('acknowledgeForeignArchive')).toBe('true')
    expect((retryBody.get('file') as File).name).toBe('from-old-server.sql.gz')

    const firstBody = post.mock.calls[0][1] as FormData
    expect(firstBody.get('acknowledgeForeignArchive')).toBeNull()
  })
})

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
