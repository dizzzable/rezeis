import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * No component in this directory may open a WebGL context on a canvas React owns.
 *
 * THE DEFECT THIS STANDS OVER. A component renders `<canvas ref={canvasRef}>`,
 * opens the GL context on React's element, and destroys that context in its
 * effect cleanup (`renderer.forceContextLoss()`, or
 * `getExtension('WEBGL_lose_context').loseContext()`). React keeps the ELEMENT
 * across a cleanup. A canvas hands the SAME context object back to every later
 * `getContext` call, lost or not — so the next setup gets the already-dead one,
 * `createShader` returns null, and the component bails to a permanently dead
 * canvas with nothing thrown for an error boundary to catch. It reproduces on
 * every dev mount under StrictMode's double-invoke, and in production on any
 * remount over preserved DOM. `Lightning.tsx` carried it and was fixed;
 * `Lightning.context-ownership.test.tsx` proves the fix at runtime, on that one
 * component. `Ballpit.tsx` carried it too and was deleted instead — it had been
 * unreachable since the day the 131 React Bits components were vendored.
 *
 * WHY A FILE-SCANNING TEST AND NOT ANOTHER RUNTIME ONE. The runtime proof costs
 * a hand-written WebGL stub per component and only ever covers the component it
 * names. What actually reintroduces this defect is VENDORING: upstream
 * reactbits.dev still ships the `<canvas ref>` shape, so the next component
 * copied in arrives with it. Nothing else here would notice —
 * `src/components/reactbits/**` is ignored by `eslint.config.mjs`, and this is a
 * runtime ownership bug, so `tsc` (which does compile these files) has nothing
 * to say about it.
 *
 * THE FIX, when this fails: allocate the canvas inside the effect with
 * `document.createElement('canvas')`, append it to a container `<div ref>`, and
 * in the cleanup remove it from the container BEFORE releasing the context.
 * KEEP the release — WebKit frees a context slot only when the context object
 * is destroyed, and this project runs under a 16-per-web-content-process
 * ceiling. `Lightning.tsx`, `Plasma.tsx` and `Grainient.tsx` are the shape.
 *
 * WHAT THIS DOES NOT CATCH, stated so it is not assumed:
 *   • a canvas reached by `container.querySelector('canvas')` instead of a
 *     `ref` — the rule keys on a literal `ref` attribute, which is the only
 *     shape the vendored set has ever used;
 *   • a `ref` arriving through `{...props}` spread onto the canvas;
 *   • `originkit/` — a directory, so it never enters the file list. It is
 *     byte-frozen and synced from reiwa, and has two tests of its own
 *     (`originkit-manifest.test.ts`, `originkit-render-purity.test.ts`) that own
 *     its invariants. It is clean under this rule as of this commit.
 *
 * The detector walks the TypeScript AST, like `originkit-render-purity.test.ts`
 * and for the same reason: half this directory documents the defect in prose,
 * and a text match cannot tell `<canvas ref={canvasRef}>` in a comment from the
 * same characters in a return statement.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** Both ways a component in this tree destroys its own GL context. */
const CONTEXT_RELEASE_METHODS: ReadonlySet<string> = new Set([
  'forceContextLoss',
  'loseContext',
])

interface CanvasOwnership {
  /** A JSX `<canvas>` carrying a `ref` — React allocates and keeps the element. */
  reactOwnedCanvas: boolean
  /** The context living on it is destroyed somewhere in the file. */
  releasesContext: boolean
}

function inspect(fileName: string, source: string): CanvasOwnership {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  )

  let reactOwnedCanvas = false
  let releasesContext = false

  const hasRefAttribute = (
    element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ): boolean =>
    element.attributes.properties.some(
      (property) =>
        ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'ref',
    )

  const walk = (node: ts.Node): void => {
    // `<canvas>` only — `<Canvas>` is react-three-fiber, which allocates and
    // owns the element itself and is not this defect.
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === 'canvas' &&
      hasRefAttribute(node)
    ) {
      reactOwnedCanvas = true
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CONTEXT_RELEASE_METHODS.has(node.expression.name.text)
    ) {
      releasesContext = true
    }

    ts.forEachChild(node, walk)
  }

  walk(sourceFile)
  return { reactOwnedCanvas, releasesContext }
}

const violates = (report: CanvasOwnership): boolean =>
  report.reactOwnedCanvas && report.releasesContext

const componentFiles = readdirSync(HERE).filter(
  (name) => name.endsWith('.tsx') && !name.includes('.test.'),
)

describe('reactbits canvas ownership', () => {
  it('finds components to check (a silent empty scan would prove nothing)', () => {
    expect(componentFiles.length).toBeGreaterThan(100)
  })

  it('no component opens a WebGL context on a canvas React owns', () => {
    const offenders = componentFiles.filter((name) =>
      violates(inspect(name, readFileSync(join(HERE, name), 'utf8'))),
    )

    expect(
      offenders,
      'these render `<canvas ref>` AND destroy the context on it — React keeps ' +
        'that element across the effect cleanup, so the next setup inherits the ' +
        'dead context and the component renders nothing. Move the canvas into ' +
        'the effect (`document.createElement`) behind a container `<div ref>`, ' +
        'as `Lightning.tsx` does; keep the release.',
    ).toEqual([])
  })

  describe('the detector itself', () => {
    // Without these, the test above passes just as happily when `inspect` has
    // stopped being able to see anything at all — which is exactly how
    // `Lightning.test.tsx` passed 6 of 6 against a component that presented a
    // dead canvas.
    it('flags the shape `Ballpit.tsx` had', () => {
      const source = `
        const Ballpit = ({ className = '' }) => {
          const canvasRef = useRef<HTMLCanvasElement>(null);
          useEffect(() => {
            const instance = createBallpit(canvasRef.current!);
            return () => instance.renderer.forceContextLoss();
          }, []);
          return <canvas className={className} ref={canvasRef} />;
        };
      `
      expect(violates(inspect('Ballpit.tsx', source))).toBe(true)
    })

    it('ignores the shape in a comment, which half this directory contains', () => {
      const source = `
        /**
         * WHAT WENT WRONG. This rendered a \`<canvas ref={canvasRef}>\` and called
         * \`gl.getExtension('WEBGL_lose_context').loseContext()\` on cleanup.
         */
        const Lightning = () => {
          const containerRef = useRef<HTMLDivElement>(null);
          useEffect(() => {
            const canvas = document.createElement('canvas');
            containerRef.current!.appendChild(canvas);
            const gl = canvas.getContext('webgl');
            return () => {
              containerRef.current!.removeChild(canvas);
              gl!.getExtension('WEBGL_lose_context')?.loseContext();
            };
          }, []);
          return <div ref={containerRef} />;
        };
      `
      expect(violates(inspect('Lightning.tsx', source))).toBe(false)
    })

    it('does not ban a React-owned canvas that never opens a GL context', () => {
      // Fifteen files here draw 2D on a `<canvas ref>` and release nothing.
      // They are correct, and a blanket "no `<canvas ref>`" rule would fail them.
      const source = `
        const LetterGlitch = () => {
          const canvasRef = useRef<HTMLCanvasElement>(null);
          useEffect(() => {
            const ctx = canvasRef.current!.getContext('2d');
            ctx!.fillRect(0, 0, 10, 10);
          }, []);
          return <canvas ref={canvasRef} />;
        };
      `
      expect(violates(inspect('LetterGlitch.tsx', source))).toBe(false)
    })

    it('does not confuse react-three-fiber `<Canvas>` for a raw canvas', () => {
      const source = `
        const Beams = () => {
          const ref = useRef(null);
          const teardown = () => renderer.forceContextLoss();
          return <Canvas ref={ref} onCreated={teardown} />;
        };
      `
      expect(violates(inspect('Beams.tsx', source))).toBe(false)
    })
  })
})
