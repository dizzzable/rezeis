/**
 * Paper Shaders wrappers (rezeis admin — configurator preview).
 * ─────────────────────────────────────────────────────────────
 * Mirror of `reiwa/web/src/components/reactbits/paper.tsx`. Thin adapters
 * around @paper-design/shaders-react so the WEB Reiwa configurator preview
 * renders the REAL shader at 100%×100%. Keep both in lockstep.
 *
 * Apache-2.0 (Lost Coast Labs / paper.design); license ships in node_modules.
 */

import {
  Dithering,
  GrainGradient,
  MeshGradient,
  Metaballs,
  Swirl,
  Warp,
  type DitheringProps,
  type GrainGradientProps,
  type MeshGradientProps,
  type MetaballsProps,
  type SwirlProps,
  type WarpProps,
} from '@paper-design/shaders-react'

const FILL = { width: '100%', height: '100%' } as const

export function PaperMesh(props: Record<string, unknown>) {
  return <MeshGradient {...(props as unknown as MeshGradientProps)} style={FILL} />
}

export function PaperWarp(props: Record<string, unknown>) {
  return <Warp {...(props as unknown as WarpProps)} style={FILL} />
}

export function PaperGrain(props: Record<string, unknown>) {
  return <GrainGradient {...(props as unknown as GrainGradientProps)} style={FILL} />
}

export function PaperDither(props: Record<string, unknown>) {
  return <Dithering {...(props as unknown as DitheringProps)} style={FILL} />
}

export function PaperSwirl(props: Record<string, unknown>) {
  return <Swirl {...(props as unknown as SwirlProps)} style={FILL} />
}

export function PaperMetaballs(props: Record<string, unknown>) {
  return <Metaballs {...(props as unknown as MetaballsProps)} style={FILL} />
}
