import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './api'
import { redactClientLogValue, reportReactError } from './client-logger'

vi.mock('./api', () => ({
  api: {
    post: vi.fn().mockResolvedValue(undefined),
  },
}))

describe('client logger redaction', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockClear()
  })

  it('redacts sensitive fragments from client diagnostics', () => {
    const input = [
      'Request failed for https://admin.example.test/path?token=secret&email=alice@example.com',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signature',
      'Cookie: sid=abc123; refreshToken=very-secret',
      'operator alice@example.com',
      'userId=4f0c08c2-2d59-49ab-9c75-a721ef5eac20',
      'raw=0123456789abcdef0123456789abcdef',
    ].join('\n')

    const redacted = redactClientLogValue(input)

    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('alice@example.com')
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('4f0c08c2-2d59-49ab-9c75-a721ef5eac20')
    expect(redacted).not.toContain('0123456789abcdef0123456789abcdef')
    expect(redacted).toContain('[redacted-query]')
    expect(redacted).toContain('[redacted-email]')
    expect(redacted).toContain('Bearer [redacted]')
    expect(redacted).toContain('Cookie: [redacted]')
    expect(redacted).toContain('[redacted-uuid]')
    expect(redacted).toContain('[redacted]')
  })

  it('redacts React error reports before sending them to the backend', async () => {
    window.history.pushState({}, '', '/dashboard?access_token=secret-token&email=alice@example.com')
    const error = new Error('Failed for admin alice@example.com with token=secret-token')
    error.stack = 'Error: token=secret-token\n    at View (https://admin.example.test/app.js?token=secret-token)'

    reportReactError(error, '\n    at AdminPanel (https://admin.example.test/app.js?userId=4f0c08c2-2d59-49ab-9c75-a721ef5eac20)')

    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))

    const payload = vi.mocked(api.post).mock.calls[0]?.[1]
    expect(JSON.stringify(payload)).not.toContain('alice@example.com')
    expect(JSON.stringify(payload)).not.toContain('secret-token')
    expect(JSON.stringify(payload)).not.toContain('4f0c08c2-2d59-49ab-9c75-a721ef5eac20')
    expect(payload).toMatchObject({
      message: 'Failed for admin [redacted-email] with token=[redacted]',
      source: 'react.errorBoundary',
      url: 'http://localhost:3000/dashboard?[redacted-query]',
    })
  })
})
