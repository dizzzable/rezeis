import { z } from 'zod'

export const PLATFORM_ACCESS_MODES = ['PUBLIC', 'INVITED', 'PURCHASE_BLOCKED', 'REG_BLOCKED', 'RESTRICTED'] as const

export type PlatformAccessMode = (typeof PLATFORM_ACCESS_MODES)[number]

export const DEFAULT_PLATFORM_ACCESS_MODE: PlatformAccessMode = 'PUBLIC'

export const platformAccessModeSchema = z.enum(PLATFORM_ACCESS_MODES, {
  error: 'settings.platform.errors.accessModeRequired',
})

export function isPlatformAccessMode(value: string): value is PlatformAccessMode {
  return PLATFORM_ACCESS_MODES.some((mode) => mode === value)
}
