import {
  RemnawaveBandwidthStatsInterface,
  RemnawaveBandwidthWindowInterface,
} from '../interfaces/remnawave-system-stats.interface';

const WINDOW_KEYS = [
  'bandwidthLastTwoDays',
  'bandwidthLastSevenDays',
  'bandwidthLast30Days',
  'bandwidthCalendarMonth',
  'bandwidthCurrentYear',
] as const;

type BandwidthWindowKey = (typeof WINDOW_KEYS)[number];

export function normalizeBandwidthStats(raw: unknown): RemnawaveBandwidthStatsInterface {
  const root = isRecord(raw) ? raw : {};
  const normalized = Object.fromEntries(
    WINDOW_KEYS.map((key) => [key, normalizeWindow(root[key])]),
  ) as Record<BandwidthWindowKey, RemnawaveBandwidthWindowInterface>;
  return normalized as RemnawaveBandwidthStatsInterface;
}

function normalizeWindow(raw: unknown): RemnawaveBandwidthWindowInterface {
  const window = isRecord(raw) ? raw : {};
  return {
    current: toFiniteNumber(window.current),
    previous: toFiniteNumber(window.previous),
    difference: toFiniteNumber(window.difference),
  };
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
