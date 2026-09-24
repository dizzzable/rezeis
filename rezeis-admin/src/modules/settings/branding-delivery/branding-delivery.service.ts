import { Injectable, Logger } from '@nestjs/common';

import { RawCacheService } from '../../../common/cache/raw-cache.service';
import { CONFIG_VERSION_KEY } from '../../bot-config/config-versions/config-versions.constants';
import { ConfigVersionsService } from '../../bot-config/config-versions/config-versions.service';
import type { BrandingDeliveryField, BrandingDeliveryReport } from './branding-delivery-report';

/** A report as kept: what the cabinet sent, and when it arrived. */
export interface StoredBrandingDeliveryReport extends BrandingDeliveryReport {
  /** ISO time the report arrived. */
  readonly reportedAt: string;
}

/**
 * Where the reports live, in the panel's Redis (AOF). Versioned, so a later
 * change of meaning does not read these records.
 */
export const BRANDING_DELIVERY_REPORTS_KEY = 'rezeis:branding-delivery:v1:reports';

/**
 * How many versions' reports are kept. Only the current version's is ever
 * shown; the others are there so a report that arrives late — the cabinet's
 * verdict on the version BEFORE the operator's last save — cannot push out the
 * current one. A handful is plenty: a report arrives within seconds of a save.
 */
export const MAX_KEPT_BRANDING_DELIVERY_REPORTS = 10;

/**
 * BrandingDeliveryService
 * ═══════════════════════
 * Keeps the cabinet's reports on the public config it took (`record`) and
 * answers the branding page with the one that belongs to the version the panel
 * serves NOW (`currentReport`). That is the whole rule behind the page's
 * notice: a fixed value makes a new version, whose report is empty or not in
 * yet, so the notice goes away; an old report never shows after a later save;
 * a cabinet older than this release never reports, so nothing shows.
 *
 * Best-effort, like every other record the delivery check keeps: a Redis
 * problem reads as "no report" and is logged, and never fails the cabinet's
 * call or the page.
 */
@Injectable()
export class BrandingDeliveryService {
  private readonly logger = new Logger(BrandingDeliveryService.name);

  public constructor(
    private readonly store: RawCacheService,
    private readonly versions: ConfigVersionsService,
  ) {}

  /** Keep a report: newest first, one per version, a bounded few. */
  public async record(report: BrandingDeliveryReport, now: number = Date.now()): Promise<void> {
    const kept = await this.readAll();
    const next: StoredBrandingDeliveryReport[] = [
      { version: report.version, rejected: report.rejected, reportedAt: new Date(now).toISOString() },
      ...kept.filter((entry) => entry.version !== report.version),
    ].slice(0, MAX_KEPT_BRANDING_DELIVERY_REPORTS);
    try {
      await this.store.set(BRANDING_DELIVERY_REPORTS_KEY, { entries: next });
    } catch (err: unknown) {
      this.logger.warn(`Could not keep the cabinet's branding report: ${describe(err)}`);
    }
  }

  /**
   * The report on the version of the public config the panel serves now, or
   * `null` when the cabinet has said nothing about it (yet, or ever) or the
   * current version cannot be computed.
   */
  public async currentReport(): Promise<StoredBrandingDeliveryReport | null> {
    let version: string | undefined;
    try {
      version = (await this.versions.current())[CONFIG_VERSION_KEY.publicConfig];
    } catch (err: unknown) {
      this.logger.warn(`Could not compute the current public-config version: ${describe(err)}`);
      return null;
    }
    if (version === undefined) return null;
    const kept = await this.readAll();
    return kept.find((entry) => entry.version === version) ?? null;
  }

  private async readAll(): Promise<StoredBrandingDeliveryReport[]> {
    let stored: unknown;
    try {
      stored = await this.store.get<unknown>(BRANDING_DELIVERY_REPORTS_KEY);
    } catch (err: unknown) {
      this.logger.warn(`Could not read the cabinet's branding reports: ${describe(err)}`);
      return [];
    }
    const entries = (stored as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? entries.filter(isStoredReport) : [];
  }
}

function isStoredReport(value: unknown): value is StoredBrandingDeliveryReport {
  if (typeof value !== 'object' || value === null) return false;
  const { version, rejected, reportedAt } = value as Record<string, unknown>;
  return (
    typeof version === 'string' &&
    typeof reportedAt === 'string' &&
    Array.isArray(rejected) &&
    rejected.every(isField)
  );
}

function isField(value: unknown): value is BrandingDeliveryField {
  if (typeof value !== 'object' || value === null) return false;
  const { path, reason, value: shown } = value as Record<string, unknown>;
  return typeof path === 'string' && typeof reason === 'string' && typeof shown === 'string';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
