import { spawn, type ChildProcess } from 'node:child_process';

import type { OlcrtcClaimedSession } from './internal-client';

export function renderSessionCommand(template: string, session: OlcrtcClaimedSession): string {
  const values: Record<string, string> = {
    sessionId: session.sessionId,
    agentSessionId: session.agentSessionId,
    provider: session.provider,
    transport: session.transport,
    roomUrl: session.room?.externalUrl ?? session.room?.externalRoomId ?? '',
    subscriptionUri: session.subscriptionUri ?? '',
  };
  return template.replaceAll(/\{(sessionId|agentSessionId|provider|transport|roomUrl|subscriptionUri)\}/gu, (_match, key: string) => values[key] ?? '');
}

export function spawnSessionCommand(commandTemplate: string, session: OlcrtcClaimedSession, trafficCounterFile: string | null = null): ChildProcess {
  return spawn(renderSessionCommand(commandTemplate, session), {
    shell: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      OLCRTC_SESSION_ID: session.sessionId,
      OLCRTC_AGENT_SESSION_ID: session.agentSessionId,
      OLCRTC_PROVIDER: session.provider,
      OLCRTC_TRANSPORT: session.transport,
      OLCRTC_ROOM_URL: session.room?.externalUrl ?? session.room?.externalRoomId ?? '',
      OLCRTC_SUBSCRIPTION_URI: session.subscriptionUri ?? '',
      OLCRTC_TRAFFIC_COUNTER_FILE: trafficCounterFile ?? '',
    },
  });
}

export type SessionProcessTermination = 'already-exited' | 'terminated' | 'killed';

export function terminateSessionProcess(process: ChildProcess, killTimeoutMs: number): Promise<SessionProcessTermination> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve('already-exited');

  return new Promise((resolve) => {
    let settled = false;
    let escalated = false;
    const finish = (result: SessionProcessTermination) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('exit', onExit);
      resolve(result);
    };
    const onExit = () => finish(escalated ? 'killed' : 'terminated');
    const timer = setTimeout(() => {
      escalated = true;
      process.kill('SIGKILL');
    }, killTimeoutMs);

    process.once('exit', onExit);
    process.kill('SIGTERM');
  });
}
