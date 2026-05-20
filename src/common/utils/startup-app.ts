/**
 * Startup app utilities (inspired by remnawave backend-main).
 * Determines which instance type is running for conditional module loading.
 *
 * Set INSTANCE_TYPE env var: "api" | "worker" | "scheduler" | "all" (default)
 */

export type InstanceType = 'api' | 'worker' | 'scheduler' | 'all';

export function getInstanceType(): InstanceType {
  const type = (process.env.INSTANCE_TYPE ?? 'all').toLowerCase();
  if (['api', 'worker', 'scheduler', 'all'].includes(type)) {
    return type as InstanceType;
  }
  return 'all';
}

export function isRestApi(): boolean {
  const type = getInstanceType();
  return type === 'api' || type === 'all';
}

export function isWorker(): boolean {
  const type = getInstanceType();
  return type === 'worker' || type === 'all';
}

export function isScheduler(): boolean {
  const type = getInstanceType();
  return type === 'scheduler' || type === 'all';
}
