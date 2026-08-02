import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/components/reactbits/Aurora.tsx'),
  'utf8',
)

describe('Rezeis Aurora preview compatibility', () => {
  it('uses a shader dialect accepted by both WebGL1 and WebGL2', () => {
    expect(source).not.toContain('#version 300 es')
    expect(source).toContain('attribute vec2 position')
    expect(source).toContain('gl_FragColor')
  })

  it('guards renderer creation and responds to container/context lifecycle', () => {
    expect(source).toContain('try {')
    expect(source).toContain('new ResizeObserver(resize)')
    expect(source).toContain("addEventListener('webglcontextlost'")
    expect(source).toContain("addEventListener('webglcontextrestored'")
  })
})
