export const MOY_NALOG_QUEUE = 'moy-nalog';

export const MOY_NALOG_JOBS = {
  REGISTER_INCOME: 'moy-nalog.register-income',
} as const;

/** Base URL of the «Мой Налог» (lknpd) self-employed cabinet API. */
export const MOY_NALOG_BASE_URL = 'https://lknpd.nalog.ru';

/** Retry budget for a register-income job (best-effort, never blocks fulfillment). */
export const MOY_NALOG_REGISTER_INCOME_ATTEMPTS = 5;

/** Initial exponential backoff delay (ms) between register-income retries. */
export const MOY_NALOG_REGISTER_INCOME_BACKOFF_MS = 30_000;
