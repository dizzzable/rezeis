export type EntitlementState =
  | 'PENDING_ACTIVATION'
  | 'ACTIVE'
  | 'EXPIRING'
  | 'EXPIRED'
  | 'REVERSED'
  | 'REMEDIATION_REQUIRED';

export type EntitlementCommand =
  | 'ACTIVATE'
  | 'BEGIN_EXPIRY'
  | 'COMPLETE_EXPIRY'
  | 'REMEDIATE'
  | 'REVERSE';

export interface EntitlementTransitionEvent {
  readonly from: EntitlementState;
  readonly to: EntitlementState;
  readonly command: EntitlementCommand;
}

export interface EntitlementTransitionResult {
  readonly state: EntitlementState;
  readonly changed: boolean;
  readonly event: EntitlementTransitionEvent | null;
}

export type EntitlementStateErrorCode = 'INVALID_TRANSITION';

export class EntitlementStateError extends Error {
  public readonly code: EntitlementStateErrorCode;

  public constructor(message: string) {
    super(message);
    this.name = 'EntitlementStateError';
    this.code = 'INVALID_TRANSITION';
  }
}

const transitionTargets: Readonly<
  Record<EntitlementState, Partial<Record<EntitlementCommand, EntitlementState>>>
> = {
  PENDING_ACTIVATION: {
    ACTIVATE: 'ACTIVE',
    REMEDIATE: 'REMEDIATION_REQUIRED',
    REVERSE: 'REVERSED',
  },
  ACTIVE: {
    BEGIN_EXPIRY: 'EXPIRING',
    REMEDIATE: 'REMEDIATION_REQUIRED',
    REVERSE: 'REVERSED',
  },
  EXPIRING: {
    COMPLETE_EXPIRY: 'EXPIRED',
    REMEDIATE: 'REMEDIATION_REQUIRED',
    REVERSE: 'REVERSED',
  },
  EXPIRED: {
    REVERSE: 'REVERSED',
  },
  REVERSED: {},
  REMEDIATION_REQUIRED: {
    REMEDIATE: 'REMEDIATION_REQUIRED',
  },
};

const idempotentCommands: Readonly<
  Record<EntitlementState, readonly EntitlementCommand[]>
> = {
  PENDING_ACTIVATION: [],
  ACTIVE: ['ACTIVATE'],
  EXPIRING: ['BEGIN_EXPIRY'],
  EXPIRED: ['COMPLETE_EXPIRY'],
  REVERSED: ['REVERSE'],
  REMEDIATION_REQUIRED: ['REMEDIATE'],
};

export function transitionEntitlementState(
  current: EntitlementState,
  command: EntitlementCommand,
): EntitlementTransitionResult {
  if (idempotentCommands[current].includes(command)) {
    return { state: current, changed: false, event: null };
  }

  const next = transitionTargets[current][command];
  if (!next) {
    throw new EntitlementStateError(
      `Cannot apply ${command} to entitlement state ${current}`,
    );
  }

  return {
    state: next,
    changed: true,
    event: { from: current, to: next, command },
  };
}
