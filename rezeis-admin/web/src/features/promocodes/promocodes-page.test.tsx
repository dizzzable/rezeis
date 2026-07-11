import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/test-utils';
import { toast } from 'sonner';
import PromocodesPage from './promocodes-page';

vi.mock('@/lib/api', () => ({
  api: {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('PromocodesPage archive flow', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue({
      data: [
        {
          id: 'promo-cuid-1',
          code: 'GIFT-ABC',
          rewardType: 'SUBSCRIPTION',
          reward: '30',
          availability: 'ALL',
          isActive: true,
          maxActivations: 1,
          lifetime: null,
          activationsCount: 1,
          plan: { id: 'plan-1', name: 'Premium' },
        },
      ],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps the dialog open and shows the backend error when archive fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api.delete).mockRejectedValue({
      response: { data: { message: 'Archive temporarily unavailable' } },
    });

    renderWithProviders(<PromocodesPage />);

    await user.click(await screen.findByRole('button', { name: 'Archive promocode' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive promocode?' });
    expect(dialog).toHaveTextContent('Activation history will be preserved.');

    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith('/admin/promocodes/promo-cuid-1');
      expect(toast.error).toHaveBeenCalledWith('Archive temporarily unavailable');
    });
    expect(screen.getByRole('dialog', { name: 'Archive promocode?' })).toBeInTheDocument();
  });
});
