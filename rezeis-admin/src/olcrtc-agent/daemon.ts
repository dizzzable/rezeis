import type { ChildProcess } from 'node:child_process';

import type { OlcrtcAgentConfig } from './config';
import { OlcrtcInternalClient, type OlcrtcClaimedSession } from './internal-client';
import { JsonOlcrtcAgentLogger, type OlcrtcAgentLogger } from './logger';
import { renderSessionCommand, spawnSessionCommand, terminateSessionProcess } from './session-command';
import { isMissingTrafficCounterFile, readTrafficCounterSnapshot } from './traffic-counter';

interface RunningSession {
  readonly claim: OlcrtcClaimedSession;
  readonly startedAt: number;
  rxBytes: bigint;
  txBytes: bigint;
  process: ChildProcess | null;
}

export class OlcrtcAgentDaemon {
  private readonly client: OlcrtcInternalClient;
  private readonly sessions = new Map<string, RunningSession>();
  private readonly loopTimers = new Map<string, NodeJS.Timeout>();
  private readonly loopFailures = new Map<string, number>();
  private stopping = false;

  public constructor(
    private readonly config: OlcrtcAgentConfig,
    private readonly logger: OlcrtcAgentLogger = new JsonOlcrtcAgentLogger(),
  ) {
    this.client = new OlcrtcInternalClient({
      baseUrl: config.baseUrl,
      apiToken: config.apiToken,
      sharedSecret: config.sharedSecret,
    });
  }

  public async start(): Promise<void> {
    await this.sendHeartbeat();
    await this.claimUntilFull();
    this.scheduleLoop('heartbeat', this.config.heartbeatIntervalMs, () => this.sendHeartbeat());
    this.scheduleLoop('claim', this.config.pollIntervalMs, () => this.claimUntilFull());
    this.scheduleLoop('traffic', this.config.trafficIntervalMs, () => this.reportTraffic());
    this.logger.info('agent started', {
      gatewayName: this.config.gatewayName,
      capacity: this.config.capacity,
      mode: this.config.sessionCommand ? 'command' : 'control-plane-only',
    });
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.logger.info('agent stopping', { activeSessions: this.sessions.size });
    for (const timer of this.loopTimers.values()) clearTimeout(timer);
    this.loopTimers.clear();
    await Promise.all([...this.sessions.values()].map((session) => this.stopSession(session, 'agent shutdown')));
    this.logger.info('agent stopped');
  }

  private async sendHeartbeat(): Promise<void> {
    await this.client.heartbeat({
      name: this.config.gatewayName,
      managementUrl: this.config.managementUrl,
      version: this.config.version,
      capacity: this.config.capacity,
      activeSessions: this.sessions.size,
      health: {
        ok: true,
        mode: this.config.sessionCommand ? 'command' : 'control-plane-only',
        stopping: this.stopping,
      },
    });
  }

  private async claimUntilFull(): Promise<void> {
    if (this.stopping) return;
    await this.reconcileExpiredSessions();
    while (this.sessions.size < this.config.capacity) {
      const claim = await this.client.claim(this.config.gatewayName);
      if (!claim) return;
      this.logger.info('session claimed', safeSessionLogFields(claim));
      await this.startSession(claim);
    }
  }

  private async startSession(claim: OlcrtcClaimedSession): Promise<void> {
    if (this.sessions.has(claim.sessionId)) return;
    const running: RunningSession = {
      claim,
      startedAt: Date.now(),
      rxBytes: 0n,
      txBytes: 0n,
      process: null,
    };
    this.sessions.set(claim.sessionId, running);
    await this.client.report(claim.sessionId, {
      status: 'STARTING',
      agentSessionId: claim.agentSessionId,
      metadata: sessionMetadata(claim, this.config.sessionCommand ? 'command' : 'control-plane-only'),
    });

    if (this.config.sessionCommand) {
      running.process = spawnSessionCommand(this.config.sessionCommand, claim, this.renderTrafficCounterFile(claim));
      this.logger.info('session command spawned', { ...safeSessionLogFields(claim), pid: running.process.pid ?? null });
      running.process.once('exit', (code, signal) => {
        void this.handleProcessExit(running, code, signal);
      });
    }

    if (!this.sessions.has(claim.sessionId)) return;

    await this.client.report(claim.sessionId, {
      status: 'ACTIVE',
      agentSessionId: claim.agentSessionId,
      metadata: {
        ...sessionMetadata(claim, this.config.sessionCommand ? 'command' : 'control-plane-only'),
        pid: running.process?.pid ?? null,
      },
    });
    this.logger.info('session active', { ...safeSessionLogFields(claim), pid: running.process?.pid ?? null });
  }

  private async stopSession(session: RunningSession, reason: string): Promise<void> {
    this.sessions.delete(session.claim.sessionId);
    const termination = session.process
      ? await terminateSessionProcess(session.process, this.config.sessionKillTimeoutMs)
      : 'no-process';
    this.logger.info('session stopping', { ...safeSessionLogFields(session.claim), reason, termination });
    await this.client.report(session.claim.sessionId, {
      status: 'STOPPED',
      agentSessionId: session.claim.agentSessionId,
      lastError: reason,
      metadata: { stoppedBy: this.config.gatewayName, termination, uptimeMs: Date.now() - session.startedAt },
    });
  }

  private async handleProcessExit(session: RunningSession, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (!this.sessions.has(session.claim.sessionId)) return;
    this.sessions.delete(session.claim.sessionId);
    const ok = code === 0 && signal === null;
    this.logger.info(ok ? 'session command exited' : 'session command failed', {
      ...safeSessionLogFields(session.claim),
      exitCode: code,
      signal,
      uptimeMs: Date.now() - session.startedAt,
    });
    await this.client.report(session.claim.sessionId, {
      status: ok ? 'STOPPED' : 'FAILED',
      agentSessionId: session.claim.agentSessionId,
      lastError: ok ? undefined : `session command exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      metadata: { exitCode: code, signal, uptimeMs: Date.now() - session.startedAt },
    });
  }

  private async reportTraffic(): Promise<void> {
    await this.reconcileExpiredSessions();
    await this.refreshTrafficCounters();
    const observedAt = new Date().toISOString();
    await Promise.all([...this.sessions.values()].map((session) => this.client.traffic(session.claim.sessionId, {
      rxBytes: String(session.rxBytes),
      txBytes: String(session.txBytes),
      source: this.config.gatewayName,
      observedAt,
      idempotencyKey: `${session.claim.agentSessionId}:${observedAt}`,
      metadata: { intervalMs: this.config.trafficIntervalMs, counterSource: this.config.trafficCounterFileTemplate ? 'file' : 'baseline' },
    })));
  }

  private async refreshTrafficCounters(): Promise<void> {
    if (!this.config.trafficCounterFileTemplate) return;
    await Promise.all([...this.sessions.values()].map(async (session) => {
      const filePath = this.renderTrafficCounterFile(session.claim);
      if (!filePath) return;
      try {
        const snapshot = await readTrafficCounterSnapshot(filePath);
        session.rxBytes = snapshot.rxBytes;
        session.txBytes = snapshot.txBytes;
      } catch (error) {
        if (isMissingTrafficCounterFile(error)) return;
        this.logger.warn('traffic counter snapshot ignored', { ...safeSessionLogFields(session.claim), filePath, error });
      }
    }));
  }

  private renderTrafficCounterFile(claim: OlcrtcClaimedSession): string | null {
    return this.config.trafficCounterFileTemplate ? renderSessionCommand(this.config.trafficCounterFileTemplate, claim) : null;
  }

  private scheduleLoop(label: string, intervalMs: number, fn: () => Promise<void>): void {
    const run = async () => {
      if (this.stopping) return;
      await this.safe(label, fn);
      if (this.stopping) return;
      const failures = this.loopFailures.get(label) ?? 0;
      const timer = setTimeout(() => void run(), nextAgentLoopDelayMs(intervalMs, failures));
      this.loopTimers.set(label, timer);
    };
    const timer = setTimeout(() => void run(), nextAgentLoopDelayMs(intervalMs, 0));
    this.loopTimers.set(label, timer);
  }

  private async safe(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.loopFailures.set(label, 0);
    } catch (error) {
      this.loopFailures.set(label, (this.loopFailures.get(label) ?? 0) + 1);
      this.logger.error('agent loop failed', {
        loop: label,
        consecutiveFailures: this.loopFailures.get(label) ?? 0,
        error,
      });
    }
  }

  private async reconcileExpiredSessions(nowMs = Date.now()): Promise<void> {
    const expired = [...this.sessions.values()].filter((session) => isExpiredSession(session.claim, nowMs));
    for (const session of expired) {
      this.logger.warn('session lease expired', safeSessionLogFields(session.claim));
    }
    await Promise.all(expired.map((session) => this.stopSession(session, 'session expired by control plane')));
  }
}

function sessionMetadata(claim: OlcrtcClaimedSession, mode: string): Record<string, unknown> {
  return {
    mode,
    provider: claim.provider,
    transport: claim.transport,
    roomUrl: claim.room?.externalUrl ?? claim.room?.externalRoomId ?? null,
  };
}

function safeSessionLogFields(claim: OlcrtcClaimedSession): Record<string, unknown> {
  return {
    sessionId: claim.sessionId,
    agentSessionId: claim.agentSessionId,
    userId: claim.userId,
    subscriptionId: claim.subscriptionId,
    profileId: claim.profileId,
    provider: claim.provider,
    transport: claim.transport,
    roomId: claim.room?.id ?? null,
    expiresAt: claim.expiresAt,
  };
}

export function isExpiredSession(claim: Pick<OlcrtcClaimedSession, 'expiresAt'>, nowMs = Date.now()): boolean {
  if (!claim.expiresAt) return false;
  const expiresAtMs = Date.parse(claim.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

export function nextAgentLoopDelayMs(baseIntervalMs: number, consecutiveFailures: number, random = Math.random()): number {
  const boundedFailures = Math.min(Math.max(0, consecutiveFailures), 6);
  const backoffMultiplier = boundedFailures === 0 ? 1 : 2 ** boundedFailures;
  const jitterMultiplier = 0.8 + Math.min(Math.max(random, 0), 1) * 0.4;
  return Math.round(Math.min(baseIntervalMs * backoffMultiplier * jitterMultiplier, 60_000));
}
