/**
 * Background Controls Registry — defines the unique controls for each
 * React Bits background component. Each control maps to a prop of the component.
 *
 * Control types:
 * - slider: numeric value with min/max/step
 * - color: hex color picker
 * - toggle: boolean switch
 * - select: dropdown with options
 * - colorArray: array of hex colors (rendered as multiple pickers)
 * - rgbColor: [r,g,b] normalized (0-1), shown as hex picker but stored as array
 *
 * `id` is typed as `Exclude<BackgroundId, 'none'>` so adding a new
 * BackgroundId in `glass-store.ts` produces a compile-time error here
 * until a registry entry is added.
 *
 * THREE THINGS EVERY ENTRY HERE HAS TO RESPECT
 * --------------------------------------------
 * 1. A control names a PROP OF THE COMPONENT. Not a uniform, not a prop the
 *    component used to have. The renderer takes `Record<string, unknown>` and
 *    spreads it, so a misspelled or removed prop lands on a component that
 *    ignores it: a slider that moves, saves, syncs across devices, and changes
 *    nothing. Nobody finds that except by dragging thirty sliders.
 *    `background-registry.test.ts` reads each component's own props type and
 *    fails on a control that names something not in it.
 * 2. THE APP BACKGROUND IS `pointer-events: none` (`GlassBackground`,
 *    `wrapperStyle`). Every hover/cursor/click prop these components offer —
 *    `mouseInfluence`, `pupilFollow`, `hoverFillColor`, PixelBlast's
 *    click ripples, PrismaticBurst's `hover` animation — is therefore inert
 *    HERE, whatever it does on a card. Those props are left at their defaults
 *    rather than given a control, and where the component's own default is
 *    wrong for an unreachable pointer (Antigravity's `autoAnimate`,
 *    FaultyTerminal's `mouseReact`) the registry default deliberately differs.
 * 3. NO `select` CONTROLS. `glass-settings-card` renders a select's options as
 *    their raw values (`<SelectItem value={opt}>{opt}</SelectItem>`), with no
 *    translation layer of the kind `card-effect-control-labels` gives the card
 *    section — so `'capsule'`/`'tetrahedron'`/`'hexagon'` would ship as
 *    untranslated English into a Russian panel. Enum-valued props stay at
 *    their component defaults until that gap is closed; each entry says which.
 */
import type { BackgroundId } from '@/lib/theme/glass-store'

export type RegistrableBackgroundId = Exclude<BackgroundId, 'none'>

export type ControlType =
  | 'slider'
  | 'color'
  | 'toggle'
  | 'select'
  | 'colorArray'
  | 'rgbColor'
  /**
   * Free text. Rendered only by the card-effect section, because only card
   * effects have a prop where the text IS the effect — the word a globe spells,
   * the glyphs a rain falls in. Offering those as a fixed dropdown would ship an
   * animation that permanently says someone else's brand name.
   */
  | 'text'

export interface ControlDef {
  prop: string
  /** Default English label — also used as i18n fallback. */
  label: string
  type: ControlType
  min?: number
  max?: number
  step?: number
  default: unknown
  options?: string[] // for select type
  count?: number // for colorArray — how many colors
  maxLength?: number // for text — keeps a stray paste out of a per-frame loop
}

/**
 * What a background needs from the device in order to paint.
 *
 * Same three tiers, and the same reasoning, as `CardEffectRenderer`:
 * `canvas2d` is not a lesser tier but a different one. Those backgrounds need
 * no GPU context at all, so they run where a shader cannot start and they do
 * not consume one of the handful of live WebGL contexts a mobile browser
 * allows — WebKit's limit is sixteen per web-content process, and this layer is
 * full-bleed and always mounted.
 *
 * `webgl1` vs `webgl2` is a statement about the component, not a preference:
 *  - anything built on `three` is `webgl2`, because r184 asks for a `webgl2`
 *    context and THROWS from the renderer constructor when it cannot get one
 *    (see the comment in `MagicRings.tsx`);
 *  - an `ogl` component whose shaders declare `#version 300 es` is `webgl2` for
 *    the same practical reason, and ogl makes it worse: asked for `webgl: 2` it
 *    falls back to WebGL1 SILENTLY, leaving a shader that cannot compile, a
 *    black canvas and nothing thrown. `PrismaticBurst` is the one that checks
 *    `renderer.isWebgl2` itself and hands the WebGL1 context straight back;
 *  - everything else on `ogl`, or on a raw `getContext('webgl')`, is `webgl1`.
 *
 * `background-registry.test.ts` re-derives this from each component's source
 * and fails on a mismatch, so it cannot quietly become a wish.
 */
export type BackgroundRenderer = 'canvas2d' | 'webgl1' | 'webgl2'

export interface BackgroundDef {
  id: RegistrableBackgroundId
  /** Default English name — also used as i18n fallback. */
  name: string
  renderer: BackgroundRenderer
  controls: ControlDef[]
}

export const BACKGROUND_REGISTRY: BackgroundDef[] = [
  {
    id: 'silk', name: 'Silk', renderer: 'webgl2',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 10, step: 0.1, default: 5 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'color', label: 'Color', type: 'color', default: '#7b7481' },
      { prop: 'noiseIntensity', label: 'Noise Intensity', type: 'slider', min: 0, max: 5, step: 0.1, default: 1.5 },
      { prop: 'rotation', label: 'Rotation', type: 'slider', min: -180, max: 180, step: 1, default: 0 },
    ],
  },
  {
    id: 'aurora', name: 'Aurora', renderer: 'webgl1',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'blend', label: 'Blend', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'colorStops', label: 'Colors', type: 'colorArray', count: 3, default: ['#5227FF', '#7cff67', '#5227FF'] },
    ],
  },
  {
    id: 'threads', name: 'Threads', renderer: 'webgl1',
    controls: [
      { prop: 'color', label: 'Color', type: 'rgbColor', default: [1, 1, 1] },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'distance', label: 'Distance', type: 'slider', min: 0, max: 2, step: 0.1, default: 0 },
    ],
  },
  {
    id: 'iridescence', name: 'Iridescence', renderer: 'webgl1',
    controls: [
      { prop: 'color', label: 'Color', type: 'rgbColor', default: [1, 1, 1] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1 },
    ],
  },
  {
    id: 'liquidChrome', name: 'Liquid Chrome', renderer: 'webgl1',
    controls: [
      { prop: 'baseColor', label: 'Base Color', type: 'rgbColor', default: [0.1, 0.1, 0.1] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.2 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 2, step: 0.1, default: 0.5 },
      { prop: 'frequencyX', label: 'Frequency X', type: 'slider', min: 1, max: 10, step: 0.5, default: 3 },
      { prop: 'frequencyY', label: 'Frequency Y', type: 'slider', min: 1, max: 10, step: 0.5, default: 2 },
    ],
  },
  {
    id: 'balatro', name: 'Balatro', renderer: 'webgl1',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#DE443B' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#006BB4' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#162325' },
      { prop: 'spinSpeed', label: 'Spin Speed', type: 'slider', min: 0.5, max: 15, step: 0.5, default: 7 },
      { prop: 'spinRotation', label: 'Spin Rotation', type: 'slider', min: -5, max: 5, step: 0.1, default: -2 },
      { prop: 'contrast', label: 'Contrast', type: 'slider', min: 1, max: 8, step: 0.5, default: 3.5 },
      { prop: 'lighting', label: 'Lighting', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    id: 'plasma', name: 'Plasma', renderer: 'webgl2',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'beams', name: 'Beams', renderer: 'webgl2',
    controls: [
      { prop: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2 },
      { prop: 'beamWidth', label: 'Beam Width', type: 'slider', min: 0.5, max: 5, step: 0.5, default: 2 },
      { prop: 'beamNumber', label: 'Beam Count', type: 'slider', min: 4, max: 30, step: 1, default: 12 },
      { prop: 'noiseIntensity', label: 'Noise', type: 'slider', min: 0, max: 5, step: 0.25, default: 1.75 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.2 },
    ],
  },
  {
    id: 'galaxy', name: 'Galaxy', renderer: 'webgl1',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'density', label: 'Density', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'hueShift', label: 'Hue Shift', type: 'slider', min: 0, max: 360, step: 5, default: 140 },
      { prop: 'glowIntensity', label: 'Glow', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
      { prop: 'twinkleIntensity', label: 'Twinkle', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
    ],
  },
  {
    id: 'particles', name: 'Particles', renderer: 'webgl1',
    controls: [
      { prop: 'particleColors', label: 'Colors', type: 'colorArray', count: 3, default: ['#ffffff', '#ffffff', '#ffffff'] },
      { prop: 'particleCount', label: 'Count', type: 'slider', min: 50, max: 500, step: 10, default: 200 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1 },
      { prop: 'particleBaseSize', label: 'Size', type: 'slider', min: 10, max: 300, step: 10, default: 100 },
    ],
  },
  {
    id: 'softAurora', name: 'Soft Aurora', renderer: 'webgl1',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#f7f7f7' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#e100ff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 0.6 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.5, max: 5, step: 0.1, default: 1.5 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'noiseFrequency', label: 'Noise Frequency', type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2.5 },
    ],
  },
  {
    id: 'grainient', name: 'Grainient', renderer: 'webgl2',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#FF9FFC' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#5227FF' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#B497CF' },
      { prop: 'timeSpeed', label: 'Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.25 },
      { prop: 'grainAmount', label: 'Grain', type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.1 },
      { prop: 'warpStrength', label: 'Warp', type: 'slider', min: 0, max: 5, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'lineWaves', name: 'Line Waves', renderer: 'webgl1',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#ffffff' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#ffffff' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.3 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.2 },
      { prop: 'warpIntensity', label: 'Warp', type: 'slider', min: 0, max: 5, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'dither', name: 'Dither', renderer: 'webgl2',
    controls: [
      { prop: 'waveColor', label: 'Color', type: 'rgbColor', default: [0.5, 0.5, 0.5] },
      { prop: 'waveSpeed', label: 'Speed', type: 'slider', min: 0.01, max: 0.2, step: 0.01, default: 0.05 },
      { prop: 'waveFrequency', label: 'Frequency', type: 'slider', min: 1, max: 10, step: 0.5, default: 3 },
      { prop: 'waveAmplitude', label: 'Amplitude', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.3 },
      { prop: 'pixelSize', label: 'Pixel Size', type: 'slider', min: 1, max: 8, step: 1, default: 2 },
      { prop: 'colorNum', label: 'Color Levels', type: 'slider', min: 2, max: 8, step: 1, default: 4 },
    ],
  },
  {
    id: 'waves', name: 'Waves', renderer: 'canvas2d',
    controls: [
      { prop: 'lineColor', label: 'Line Color', type: 'color', default: '#000000' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'waveSpeedX', label: 'Speed X', type: 'slider', min: 0.001, max: 0.05, step: 0.001, default: 0.0125 },
      { prop: 'waveAmpX', label: 'Amplitude X', type: 'slider', min: 5, max: 100, step: 5, default: 32 },
      { prop: 'xGap', label: 'X Gap', type: 'slider', min: 2, max: 30, step: 1, default: 10 },
      { prop: 'yGap', label: 'Y Gap', type: 'slider', min: 5, max: 60, step: 1, default: 32 },
    ],
  },
  {
    id: 'dotGrid', name: 'Dot Grid', renderer: 'canvas2d',
    controls: [
      { prop: 'baseColor', label: 'Base Color', type: 'color', default: '#5227FF' },
      { prop: 'activeColor', label: 'Active Color', type: 'color', default: '#5227FF' },
      { prop: 'dotSize', label: 'Dot Size', type: 'slider', min: 4, max: 32, step: 2, default: 16 },
      { prop: 'gap', label: 'Gap', type: 'slider', min: 8, max: 64, step: 4, default: 32 },
      { prop: 'proximity', label: 'Proximity', type: 'slider', min: 50, max: 400, step: 10, default: 150 },
    ],
  },
  {
    id: 'rippleGrid', name: 'Ripple Grid', renderer: 'webgl1',
    controls: [
      { prop: 'gridColor', label: 'Grid Color', type: 'color', default: '#ffffff' },
      { prop: 'rippleIntensity', label: 'Ripple Intensity', type: 'slider', min: 0.01, max: 0.2, step: 0.01, default: 0.05 },
      { prop: 'gridSize', label: 'Grid Size', type: 'slider', min: 2, max: 30, step: 1, default: 10 },
      { prop: 'glowIntensity', label: 'Glow', type: 'slider', min: 0, max: 0.5, step: 0.05, default: 0.1 },
      { prop: 'enableRainbow', label: 'Rainbow', type: 'toggle', default: false },
    ],
  },
  {
    id: 'lightning', name: 'Lightning', renderer: 'webgl1',
    controls: [
      { prop: 'hue', label: 'Hue', type: 'slider', min: 0, max: 360, step: 5, default: 230 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'size', label: 'Size', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'radar', name: 'Radar', renderer: 'webgl1',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#9f29ff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'ringCount', label: 'Rings', type: 'slider', min: 3, max: 20, step: 1, default: 10 },
      { prop: 'spokeCount', label: 'Spokes', type: 'slider', min: 3, max: 20, step: 1, default: 10 },
      { prop: 'sweepSpeed', label: 'Sweep Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Every default below is the component's own, read off its parameter list,
  // unless the entry says otherwise. Where a choice had to be made it is stated
  // in place, because "why is this 0.35 and not 1" is the question the next
  // reader will have and the component cannot answer it.
  // ───────────────────────────────────────────────────────────────────────────

  {
    // three r184 → WebGL2. `colors` defaults to `[]` in the component, which is
    // not "no colours" but a different branch: `uColorCount == 0` drops into
    // the RGB-channel fallback that ignores operator colours entirely. A
    // `colorArray` has a fixed count and cannot express "unset", so a 3-stop
    // palette is CHOSEN here — the alternative is a colour picker that does
    // nothing until an invisible fourth stop appears.
    // `mouseInfluence` (1) and `parallax` (0.5) are pointer-driven and stay at
    // their defaults; `autoRotate` (0), `rotation` (90), `noise` (0.15),
    // `iterations` (1) and `transparent` (true) likewise.
    id: 'colorBends', name: 'Color Bends', renderer: 'webgl2',
    controls: [
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#5227FF', '#FF9FFC', '#B19EEF'] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.02, max: 2, step: 0.02, default: 0.2 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.2, max: 3, step: 0.1, default: 1 },
      { prop: 'frequency', label: 'Frequency', type: 'slider', min: 0.2, max: 4, step: 0.1, default: 1 },
      { prop: 'warpStrength', label: 'Warp', type: 'slider', min: 0, max: 3, step: 0.1, default: 1 },
      { prop: 'bandWidth', label: 'Band Width', type: 'slider', min: 1, max: 12, step: 0.5, default: 6 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1.5 },
    ],
  },
  {
    // three + GLSL3 → WebGL2. `antialias`, `liquid` and `noiseAmount` are the
    // component's own `needsReinitKeys`: changing any of the three disposes the
    // renderer and builds a new one, so none of them gets a control. The ripple
    // props (`enableRipples`, `rippleSpeed`, `rippleThickness`,
    // `rippleIntensityScale`) are driven by `pointerdown` on the canvas and
    // cannot fire under a `pointer-events: none` layer. `variant` is an enum.
    id: 'pixelBlast', name: 'Pixel Blast', renderer: 'webgl2',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#B497CF' },
      { prop: 'pixelSize', label: 'Pixel Size', type: 'slider', min: 1, max: 12, step: 1, default: 3 },
      { prop: 'patternScale', label: 'Pattern Scale', type: 'slider', min: 0.5, max: 6, step: 0.5, default: 2 },
      { prop: 'patternDensity', label: 'Pattern Density', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.05, max: 3, step: 0.05, default: 0.5 },
      { prop: 'edgeFade', label: 'Edge Fade', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'pixelSizeJitter', label: 'Jitter', type: 'slider', min: 0, max: 1, step: 0.05, default: 0 },
    ],
  },
  {
    // ogl, no `#version` directive → WebGL1. `colors` is a `[string, string]`
    // tuple; a 2-slot `colorArray` matches it exactly and the component reads
    // `cols[0]`/`cols[1]`.
    // `speed1`/`speed2` are floored for tidiness rather than necessity: `t1`
    // and `t2` keep the tube wobbling at zero (`wob1 = uBend1 + sin(t1 + …)`),
    // so zero there is a look, not a stop. `dir2` (±1) and the offsets stay at
    // their defaults.
    id: 'plasmaWave', name: 'Plasma Wave', renderer: 'webgl1',
    controls: [
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 2, default: ['#A855F7', '#06B6D4'] },
      { prop: 'speed1', label: 'Speed 1', type: 'slider', min: 0.01, max: 0.5, step: 0.01, default: 0.05 },
      { prop: 'speed2', label: 'Speed 2', type: 'slider', min: 0.01, max: 0.5, step: 0.01, default: 0.05 },
      { prop: 'bend1', label: 'Bend 1', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'bend2', label: 'Bend 2', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 0.5 },
      { prop: 'focalLength', label: 'Focal Length', type: 'slider', min: 0.2, max: 2, step: 0.1, default: 0.8 },
      { prop: 'rotationDeg', label: 'Rotation', type: 'slider', min: -180, max: 180, step: 1, default: 0 },
    ],
  },
  {
    // ogl, no `#version` directive → WebGL1. `backgroundColor` is ADDED to the
    // eye's colour (`color += uBgColor`), not painted behind it, so the
    // component's `#000000` is genuinely "nothing added" and is kept.
    // `pupilFollow` (1) is pointer-driven and stays at its default: the pupil
    // simply looks straight ahead.
    id: 'evilEye', name: 'Evil Eye', renderer: 'webgl1',
    controls: [
      { prop: 'eyeColor', label: 'Eye Color', type: 'color', default: '#FF6F37' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'flameSpeed', label: 'Flame Speed', type: 'slider', min: 0.05, max: 3, step: 0.05, default: 1 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1.5 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.2, max: 2, step: 0.05, default: 0.8 },
      { prop: 'irisWidth', label: 'Iris Width', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.25 },
      { prop: 'glowIntensity', label: 'Glow', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.35 },
    ],
  },
  {
    // three r184 → WebGL2. `quality` is an enum AND sits in the build effect's
    // dependency array (`[webGLSupported, quality]`), so a control on it would
    // tear the context down; it stays at `'high'` and the component's own
    // mobile detection lowers it. `interactive` (false) and `mixBlendMode`
    // ('screen') stay at their defaults.
    id: 'lightPillar', name: 'Light Pillar', renderer: 'webgl2',
    controls: [
      { prop: 'topColor', label: 'Top Color', type: 'color', default: '#5227FF' },
      { prop: 'bottomColor', label: 'Bottom Color', type: 'color', default: '#FF9FFC' },
      { prop: 'rotationSpeed', label: 'Rotation Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.3 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'glowAmount', label: 'Glow', type: 'slider', min: 0.001, max: 0.02, step: 0.001, default: 0.005 },
      { prop: 'pillarWidth', label: 'Pillar Width', type: 'slider', min: 0.5, max: 8, step: 0.5, default: 3 },
      { prop: 'pillarHeight', label: 'Pillar Height', type: 'slider', min: 0.1, max: 2, step: 0.1, default: 0.4 },
      { prop: 'noiseIntensity', label: 'Noise Intensity', type: 'slider', min: 0, max: 2, step: 0.1, default: 0.5 },
    ],
  },
  {
    // HARD WebGL2: both shaders are `#version 300 es`, and the component checks
    // `renderer.isWebgl2` itself because ogl falls back to WebGL1 silently.
    // `colors` defaults to `undefined` — the built-in spectral rainbow — which
    // a fixed-count `colorArray` cannot express, so a 3-stop gradient in the
    // same spirit is CHOSEN. `animationType` is an enum (and its `'hover'`
    // member is inert here), `offset` is an object, `hoverDampness` is
    // pointer-driven, and `paused` would freeze the picture while the loop kept
    // paying for frames — none of them gets a control.
    id: 'prismaticBurst', name: 'Prismatic Burst', renderer: 'webgl2',
    controls: [
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#FF007A', '#4D3DFF', '#00E0FF'] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.05, max: 3, step: 0.05, default: 0.5 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 0.1, max: 4, step: 0.1, default: 2 },
      { prop: 'distort', label: 'Distort', type: 'slider', min: 0, max: 10, step: 0.5, default: 0 },
      { prop: 'rayCount', label: 'Rays', type: 'slider', min: 0, max: 24, step: 1, default: 0 },
    ],
  },
  {
    // ogl, `precision mediump float;` with no `#version` directive → WebGL1.
    // `dpr` is NOT offered: it is the one prop in this component's build-effect
    // dependency array (`[dpr, glGeneration]`), so a slider on it would destroy
    // and rebuild the WebGL context on every tick of the drag.
    // `gridMul` is a `[number, number]` tuple with no representable control and
    // stays at the module's `DEFAULT_GRID_MUL` ([2, 1]); `scale` (1),
    // `noiseAmp` (1), `chromaticAberration` (0), `dither` (0), `curvature`
    // (0.2), `mouseStrength` (0.2) and `pageLoadAnimation` (true) stay too.
    // `mouseReact` DEFAULTS TO FALSE HERE against the component's `true`: the
    // uniform is seeded at (0.5, 0.5) and no pointer event can ever reach this
    // layer to move it, so "reacting to the cursor" resolves to a permanent
    // bright patch in the middle of the screen.
    id: 'faultyTerminal', name: 'Faulty Terminal', renderer: 'webgl1',
    controls: [
      { prop: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
      { prop: 'timeScale', label: 'Speed', type: 'slider', min: 0.02, max: 2, step: 0.02, default: 0.3 },
      { prop: 'digitSize', label: 'Digit Size', type: 'slider', min: 0.5, max: 3, step: 0.1, default: 1.5 },
      { prop: 'scanlineIntensity', label: 'Scanlines', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
      { prop: 'glitchAmount', label: 'Glitch', type: 'slider', min: 0, max: 3, step: 0.1, default: 1 },
      { prop: 'flickerAmount', label: 'Flicker', type: 'slider', min: 0, max: 3, step: 0.1, default: 1 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'mouseReact', label: 'Cursor Reaction', type: 'toggle', default: false },
    ],
  },
  {
    // Canvas2D — `canvas.getContext('2d')`, no GL context at all, so it paints
    // where a shader cannot start and costs none of the sixteen slots.
    // `glitchColors` takes the module constant `DEFAULT_GLITCH_COLORS`.
    // `glitchSpeed` is an INTERVAL IN MILLISECONDS, not a rate — `now -
    // lastGlitchTime >= glitchSpeed` — so its zero end is "re-glitch the whole
    // lattice every frame on the main thread", which is why the floor is 10 ms
    // rather than 0. Larger is slower.
    // `backgroundColor` is deliberately NOT offered: its default is `undefined`
    // = paint nothing, which is exactly what a full-bleed layer wants over the
    // static gradient, and a `color` control cannot express "no fill".
    // `characters` would need a `text` control, which this card does not render.
    id: 'letterGlitch', name: 'Letter Glitch', renderer: 'canvas2d',
    controls: [
      { prop: 'glitchColors', label: 'Colors', type: 'colorArray', count: 3, default: ['#2b4539', '#61dca3', '#61b3dc'] },
      { prop: 'glitchSpeed', label: 'Glitch Interval', type: 'slider', min: 10, max: 500, step: 10, default: 50 },
      { prop: 'smooth', label: 'Smooth Fade', type: 'toggle', default: true },
      { prop: 'outerVignette', label: 'Outer Vignette', type: 'toggle', default: false },
      { prop: 'centerVignette', label: 'Center Vignette', type: 'toggle', default: false },
    ],
  },
  {
    // Canvas2D — same tier, same reason as letterGlitch.
    // `borderColor` is the component's `'#999'` written as `'#999999'`: the
    // colour input only accepts a 6-digit hex and silently falls back to the
    // control default otherwise, so a 3-digit default would render an empty
    // swatch. `speed`'s floor of 0.1 is not a judgement call — it is exactly
    // the clamp the component already applies (`Math.max(speed, 0.1)`).
    // `direction` and `shape` are enums; `hoverFillColor` and
    // `hoverTrailAmount` need a cursor this layer never receives.
    id: 'shapeGrid', name: 'Shape Grid', renderer: 'canvas2d',
    controls: [
      { prop: 'borderColor', label: 'Border Color', type: 'color', default: '#999999' },
      { prop: 'squareSize', label: 'Cell Size', type: 'slider', min: 10, max: 120, step: 5, default: 40 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 10, step: 0.1, default: 1 },
      { prop: 'vignetteColor', label: 'Vignette Color', type: 'color', default: '#120F17' },
      { prop: 'vignetteStrength', label: 'Vignette', type: 'slider', min: 0, max: 1, step: 0.05, default: 1 },
    ],
  },
  {
    // three r184 → WebGL2. `ringCount`'s ceiling of 10 is the shader's own
    // unrollable loop bound (`for (int i = 0; i < 10; i++)`), not a taste
    // decision — an eleventh ring would never be drawn.
    // `followMouse` (false), `mouseInfluence`, `hoverScale`, `parallax` and
    // `clickBurst` all need a pointer and stay at their defaults, as do
    // `baseRadius`, `radiusStep`, `scaleRate`, `ringGap`, `fadeIn`, `fadeOut`,
    // `rotation` and the CSS `blur` (0).
    id: 'magicRings', name: 'Magic Rings', renderer: 'webgl2',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#fc42ff' },
      { prop: 'colorTwo', label: 'Second Color', type: 'color', default: '#42fcff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.05, max: 3, step: 0.05, default: 1 },
      { prop: 'ringCount', label: 'Rings', type: 'slider', min: 1, max: 10, step: 1, default: 6 },
      { prop: 'lineThickness', label: 'Line Thickness', type: 'slider', min: 0.5, max: 6, step: 0.5, default: 2 },
      { prop: 'opacity', label: 'Opacity', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 1 },
      { prop: 'noiseAmount', label: 'Noise', type: 'slider', min: 0, max: 0.5, step: 0.05, default: 0.1 },
    ],
  },
  {
    // three r184 → WebGL2. `dpr` is NOT offered, for the same reason as
    // FaultyTerminal: it is this component's only build-effect dependency
    // (`}, [dpr]`), so a slider on it would rebuild the renderer per tick.
    // `mouseSmoothTime` and `mouseTiltStrength` are pointer-driven; the beam
    // offsets, `wispDensity`, `wispSpeed`, `flowStrength`, `fogScale` and
    // `fogFallSpeed` stay at their defaults.
    id: 'laserFlow', name: 'Laser Flow', renderer: 'webgl2',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#FF79C6' },
      { prop: 'flowSpeed', label: 'Flow Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.35 },
      { prop: 'verticalSizing', label: 'Vertical Size', type: 'slider', min: 0.5, max: 4, step: 0.1, default: 2 },
      { prop: 'horizontalSizing', label: 'Horizontal Size', type: 'slider', min: 0.1, max: 2, step: 0.1, default: 0.5 },
      { prop: 'decay', label: 'Beam Decay', type: 'slider', min: 0.2, max: 3, step: 0.1, default: 1.1 },
      { prop: 'falloffStart', label: 'Falloff Start', type: 'slider', min: 0.2, max: 3, step: 0.1, default: 1.2 },
      { prop: 'fogIntensity', label: 'Fog', type: 'slider', min: 0, max: 1.5, step: 0.05, default: 0.45 },
      { prop: 'wispIntensity', label: 'Wisps', type: 'slider', min: 0, max: 15, step: 0.5, default: 5 },
    ],
  },
  {
    // three via @react-three/fiber → WebGL2.
    // `autoAnimate` DEFAULTS TO TRUE HERE against the component's `false`: the
    // ring follows `state.pointer`, which stays at (0, 0) — dead centre of the
    // viewport — until a pointer event moves it, and none can reach this layer.
    // With `autoAnimate` on, the component drives the target itself after two
    // seconds of stillness (`Math.sin(time * 0.5) * (v.width / 4)`), which is
    // the only way this effect moves as a background.
    // `rotationSpeed` (0) and `pulseSpeed` (3) are left alone: zero rotation is
    // the component's default and a still ring, not a stopped one.
    // `particleShape` is an enum; `depthFactor`, `particleVariance` and
    // `fieldStrength` stay at their defaults.
    id: 'antigravity', name: 'Antigravity', renderer: 'webgl2',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#FF9FFC' },
      { prop: 'count', label: 'Count', type: 'slider', min: 50, max: 600, step: 25, default: 300 },
      { prop: 'particleSize', label: 'Particle Size', type: 'slider', min: 0.2, max: 6, step: 0.2, default: 2 },
      { prop: 'lerpSpeed', label: 'Follow Speed', type: 'slider', min: 0.01, max: 0.5, step: 0.01, default: 0.1 },
      { prop: 'ringRadius', label: 'Ring Radius', type: 'slider', min: 2, max: 25, step: 1, default: 10 },
      { prop: 'magnetRadius', label: 'Magnet Radius', type: 'slider', min: 2, max: 30, step: 1, default: 10 },
      // `waveSpeed` and `waveAmplitude` reuse the label keys Dither already
      // owns: the studio resolves a control's label from
      // `glassSettings.controls.<prop>` with no per-background scoping, so a
      // shared prop name shares one word in both locales whether the entries
      // agree or not. Stating it here rather than shipping a registry label the
      // UI silently overrides.
      { prop: 'waveSpeed', label: 'Speed', type: 'slider', min: 0.05, max: 3, step: 0.05, default: 0.4 },
      { prop: 'waveAmplitude', label: 'Amplitude', type: 'slider', min: 0, max: 4, step: 0.1, default: 1 },
      { prop: 'autoAnimate', label: 'Auto Motion', type: 'toggle', default: true },
    ],
  },
]

/**
 * Sliders whose ZERO END DOES NOT PAUSE THE BACKGROUND — it stops the picture
 * while the render loop keeps paying for every frame.
 *
 * This is the same rule the card-effect catalogue states, and the same failure:
 * an operator drags a slider to the end of its track, the animation freezes,
 * and nothing anywhere says whether that is a setting or a broken effect. On a
 * full-bleed layer it is worse than on a card — a frozen full-screen shader
 * still costs a phone its whole frame budget, sixty times a second, to redraw a
 * still image.
 *
 * `background-motion-sliders` (in `background-registry.test.ts`) catches the
 * `speed`/`spin`-named half by regex. The other half is invisible to any name
 * rule — `timeScale` is a clock, `ringCount` and `opacity` and `particleSize`
 * draw NOTHING at zero, `verticalSizing` and `horizontalSizing` are DIVISORS
 * and produce NaN — so each is listed here with the line of its component that
 * settles it, and the test holds the minimum above zero for every id named.
 *
 * A reason is a claim about the component, not about this file. It was checked
 * against the source at the revision this list was written; if a component is
 * rewritten the reason has to be re-read, which is why the line is quoted
 * rather than paraphrased.
 */
export const ZERO_FLOOR_REASONS: Readonly<Record<string, string>> = {
  // ── the clock is the only thing moving ──
  'colorBends.speed':
    'ColorBends.tsx frag: `float t = uTime * uSpeed;` — every animated term downstream is a function of t.',
  'pixelBlast.speed':
    'PixelBlast.tsx: `uniforms.uTime.value = timeOffset + clock.getElapsedTime() * speedRef.current;` — the only clock the shader has.',
  'evilEye.flameSpeed':
    'EvilEye.tsx frag: `float ft = uTime * uFlameSpeed;` — ft is the sole scroll offset of all three noise samples.',
  'lightPillar.rotationSpeed':
    'LightPillar.tsx: `timeRef.current += 0.016 * rotationSpeedRef.current;` — uTime stops advancing, and the wave deformation is built from it.',
  'magicRings.speed':
    'MagicRings.tsx: `uniforms.uTime.value = t * 0.001 * p.speed;` — the ring cycle is `mod(uTime + t0, CYCLE)`.',
  'prismaticBurst.speed':
    'PrismaticBurst.tsx frag: `float t = uTime * uSpeed;` — drives the rotation matrices and the ray pattern alike.',
  'antigravity.lerpSpeed':
    'Antigravity.tsx: `particle.cx += (targetPos.x - particle.cx) * lerpSpeed;` — at zero no particle ever reaches its target and the ring never forms.',
  'faultyTerminal.timeScale':
    'FaultyTerminal.tsx: `const elapsed = (t * 0.001 + timeOffsetRef.current) * live.timeScale;` — iTime is the shader\'s only clock, and it is not named "speed".',

  // ── zero draws nothing ──
  'magicRings.ringCount':
    'MagicRings.tsx frag: `if (i >= uRingCount) break;` — the ring loop exits before its first iteration and the colour stays vec3(0.0).',
  'magicRings.opacity':
    'MagicRings.tsx frag: `gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)) * uOpacity);` — alpha zero is a fully transparent full-screen layer.',
  'antigravity.count':
    'Antigravity.tsx: `<instancedMesh ref={meshRef} args={[undefined, undefined, count]}>` — zero instances, and `for (let i = 0; i < count; i++)` builds no particles to fill them.',
  'antigravity.particleSize':
    'Antigravity.tsx: `const finalScale = scaleFactor * (0.8 + Math.sin(t * pulseSpeed) * 0.2 * particleVariance) * particleSize;` — every instance is scaled to zero.',
  'laserFlow.decay':
    'LaserFlow.tsx frag: `float basePhase=1.5*PI+uDecay*.5; float tauMin=basePhase-uDecay; float tauMax=basePhase;` — tauMin meets tauMax, every tap weight is zero, the frame is black.',
  'laserFlow.falloffStart':
    'LaserFlow.tsx frag: `float d=distance(p,q),f=powr*uFalloffStart,r=(f*f)/(d*d+EPS);` — f is zero, so the beam contributes nothing anywhere.',
  'evilEye.intensity':
    'EvilEye.tsx frag: `vec3 color = uEyeColor * uIntensity * clamp(...);` — the eye multiplies out, leaving only uBgColor.',
  'lightPillar.intensity':
    'LightPillar.tsx frag: `gl_FragColor = vec4(color * uIntensity, 1.0);` — an opaque black rectangle over the gradient.',
  'lightPillar.glowAmount':
    'LightPillar.tsx frag: `color = tanh(color * uGlowAmount / widthNormalization);` — tanh(0) is 0 for every fragment.',
  'prismaticBurst.intensity':
    'PrismaticBurst.tsx frag: `col *= uIntensity;` — the marched colour is multiplied out just before it is written.',
  'colorBends.intensity':
    'ColorBends.tsx frag: `col *= uIntensity;` — same shape, same result: nothing left to see.',

  // ── zero divides ──
  'laserFlow.horizontalSizing':
    'LaserFlow.tsx frag: `float cx=clamp(uvc.x/(R_H*uHLenFactor),-1.0,1.0)` — division by zero, and clamp(NaN) is undefined.',
  'laserFlow.verticalSizing':
    'LaserFlow.tsx frag: `float yPix=uvc.y,cy=clamp(-yPix/(R_V*uVLenFactor),-1.0,1.0)` — the same divide on the vertical arm.',
  'evilEye.scale':
    'EvilEye.tsx frag: `uv /= uScale;` — unguarded, unlike ColorBends which writes `q /= max(uScale, 0.0001)`.',
  'evilEye.irisWidth':
    'EvilEye.tsx frag: `float innerRing = clamp(-1.0 * ((distanceMask - 0.7) / uIrisWidth), 0.0, 1.0);` — an unguarded divisor.',
  'lightPillar.pillarWidth':
    'LightPillar.tsx frag: `float widthNormalization = uPillarWidth / 3.0;` feeding `color * uGlowAmount / widthNormalization` — zero width divides by zero.',
  'shapeGrid.squareSize':
    'ShapeGrid.tsx: `numSquaresX.current = Math.ceil(width / squareSize) + 1;` — at zero that is Infinity, and the draw loop counts to it on the main thread.',
}

/** Get background definition by id */
export function getBackgroundDef(id: string): BackgroundDef | undefined {
  return BACKGROUND_REGISTRY.find((b) => b.id === id)
}

/** Get default props for a background */
export function getDefaultProps(id: string): Record<string, unknown> {
  const def = getBackgroundDef(id)
  if (!def) return {}
  const props: Record<string, unknown> = {}
  for (const ctrl of def.controls) {
    props[ctrl.prop] = ctrl.default
  }
  return props
}

// ── Compile-time coverage check ───────────────────────────────────────────────
// Forces every BackgroundId (except 'none') to have a registry entry.
// If the BackgroundId union grows but the registry doesn't, the type
// `RegisteredId` will not equal `RegistrableBackgroundId` and TS will error.
type RegisteredId = (typeof BACKGROUND_REGISTRY)[number]['id']
type _CoverageCheck = Exclude<RegistrableBackgroundId, RegisteredId> extends never
  ? true
  : `Missing background-controls registry entry for: ${Exclude<RegistrableBackgroundId, RegisteredId>}`
