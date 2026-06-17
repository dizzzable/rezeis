import { describe, it, expect } from 'vitest'

import { parseTokens, segmentsToString, buildToken } from './emoji-token-text'

describe('parseTokens / segmentsToString', () => {
  it('splits mixed text, :slug: and {{KEY}} in order', () => {
    const segs = parseTokens('Hi :fire: and {{CARD}} pay')
    expect(segs).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'token', kind: 'slug', name: 'fire', raw: ':fire:' },
      { type: 'text', text: ' and ' },
      { type: 'token', kind: 'key', name: 'CARD', raw: '{{CARD}}' },
      { type: 'text', text: ' pay' },
    ])
  })

  it('treats unknown-shaped tokens as literal text (passthrough)', () => {
    // Mixed-case / spaces don't match either grammar → stay text.
    expect(parseTokens(':Fire: {{ card }}')).toEqual([
      { type: 'text', text: ':Fire: {{ card }}' },
    ])
  })

  it('round-trips losslessly (Property 1) for representative inputs', () => {
    const cases = [
      '',
      'plain text only',
      ':fire:',
      '{{TRIAL}}',
      'a:fire:b{{CARD}}c',
      'line1\nline2 :x: {{Y_2}}',
      'emoji 😀 with :slug_1: and {{KEY_9}}',
      ':a::b:{{A}}{{B}}',
      'trailing :tok:',
      '{{LEAD}} trailing',
    ]
    for (const input of cases) {
      expect(segmentsToString(parseTokens(input))).toBe(input)
    }
  })

  it('round-trips losslessly over many randomized token/text sequences', () => {
    const atoms = ['hello ', ' world', '\n', '😀', ':fire:', ':slug_2:', '{{CARD}}', '{{KEY_1}}', 'x', '::', '{}']
    // Deterministic LCG so the test is reproducible.
    let seed = 1234567
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < 500; i += 1) {
      const len = 1 + Math.floor(rnd() * 8)
      let input = ''
      for (let j = 0; j < len; j += 1) input += atoms[Math.floor(rnd() * atoms.length)]
      expect(segmentsToString(parseTokens(input))).toBe(input)
    }
  })

  it('buildToken produces the canonical raw form', () => {
    expect(buildToken('slug', 'fire')).toBe(':fire:')
    expect(buildToken('key', 'CARD')).toBe('{{CARD}}')
  })
})
