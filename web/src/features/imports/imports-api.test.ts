import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importsApi } from '@/features/imports/imports-api'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

describe('importsApi rollback client', () => {
  beforeEach(() => {
    mockedGet.mockReset()
    mockedPost.mockReset()
  })

  it('routes rollback batch through bounded admin imports endpoint', async () => {
    mockedPost.mockResolvedValue({
      data: {
        data: {
          batchId: 'batch-1',
          status: 'ROLLED_BACK',
          rolledBack: true,
          deletedUsers: 2,
          checkedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    })

    const result = await importsApi.rollbackBatch('batch-1')

    expect(mockedPost).toHaveBeenCalledWith('/admin/imports/batches/batch-1/rollback')
    expect(result.rolledBack).toBe(true)
    expect(result.deletedUsers).toBe(2)
  })
})
