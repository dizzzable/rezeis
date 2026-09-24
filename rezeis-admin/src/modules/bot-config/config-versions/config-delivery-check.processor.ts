import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { ConfigDeliveryCheckService } from './config-delivery-check.service';
import { CONFIG_DELIVERY_CHECK_QUEUE, type ConfigDeliveryCheckJobData } from './config-versions.constants';

/**
 * ConfigDeliveryCheckProcessor
 * ════════════════════════════
 * Runs the delivery check of a settings save two minutes after its hint
 * (`ConfigDeliveryCheckService.check`). On BullMQ rather than a timer in the
 * process that saved: the check has to survive a restart of that process in
 * the two minutes, and either container may run it — the reports it reads are
 * in Redis, not in the API container's memory.
 *
 * One attempt. The check reads and compares; a failure to read is not worth a
 * retry that would compare against a later moment than the save's deadline.
 */
@Processor(CONFIG_DELIVERY_CHECK_QUEUE, { concurrency: 1 })
export class ConfigDeliveryCheckProcessor extends WorkerHost {
  private readonly logger = new Logger(ConfigDeliveryCheckProcessor.name);

  public constructor(private readonly checks: ConfigDeliveryCheckService) {
    super();
  }

  public async process(job: Job<ConfigDeliveryCheckJobData>): Promise<{ readonly findings: number }> {
    const findings = await this.checks.check(job.data);
    if (findings.length > 0) {
      this.logger.warn(
        `Settings change ${job.data.event} (${job.data.reason}) not confirmed by the cabinet: ` +
          findings.map((finding) => `${finding.cause} ${finding.group}`).join(', '),
      );
    }
    return { findings: findings.length };
  }

  @OnWorkerEvent('failed')
  public onFailed(job: Job<ConfigDeliveryCheckJobData> | undefined, error: Error): void {
    this.logger.warn(`Delivery check ${job?.id ?? 'unknown'} (${job?.data?.event ?? 'unknown'}) failed: ${error.message}`);
  }
}
