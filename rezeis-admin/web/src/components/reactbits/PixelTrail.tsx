import { shaderMaterial, useTrailTexture } from '@react-three/drei';
import { Canvas, CanvasProps, RootState, ThreeEvent, useThree } from '@react-three/fiber';
import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

/**
 * Delete the GPU objects hanging off a scene before the context that owns them
 * goes away. Losing the context frees the driver allocations but leaves every
 * three.js wrapper — geometry buffers, material programs — attached to the
 * renderer's internal maps.
 */
const releaseSceneResources = (scene: THREE.Object3D): void => {
  scene.traverse(object => {
    const mesh = object as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
  });
};

interface GooeyFilterProps {
  id?: string;
  strength?: number;
}

interface DotMaterialUniforms {
  resolution: THREE.Vector2;
  mouseTrail: THREE.Texture | null;
  gridSize: number;
  pixelColor: THREE.Color;
}

interface SceneProps {
  gridSize: number;
  trailSize: number;
  maxAge: number;
  interpolate: number;
  easingFunction: (x: number) => number;
  pixelColor: string;
}

interface PixelTrailProps {
  gridSize?: number;
  trailSize?: number;
  maxAge?: number;
  interpolate?: number;
  easingFunction?: (x: number) => number;
  canvasProps?: Partial<CanvasProps>;
  glProps?: WebGLContextAttributes & { powerPreference?: string };
  gooeyFilter?: { id: string; strength: number };
  color?: string;
  className?: string;
}

const GooeyFilter: React.FC<GooeyFilterProps> = ({ id = 'goo-filter', strength = 10 }) => {
  return (
    <svg className="z-1 absolute overflow-hidden">
      <defs>
        <filter id={id}>
          <feGaussianBlur in="SourceGraphic" stdDeviation={strength} result="blur" />
          <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>
  );
};

const DotMaterial = shaderMaterial(
  {
    resolution: new THREE.Vector2(),
    mouseTrail: null,
    gridSize: 100,
    pixelColor: new THREE.Color('#ffffff')
  },
  /* glsl vertex shader */ `
    varying vec2 vUv;
    void main() {
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  /* glsl fragment shader */ `
    uniform vec2 resolution;
    uniform sampler2D mouseTrail;
    uniform float gridSize;
    uniform vec3 pixelColor;

    vec2 coverUv(vec2 uv) {
      vec2 s = resolution.xy / max(resolution.x, resolution.y);
      vec2 newUv = (uv - 0.5) * s + 0.5;
      return clamp(newUv, 0.0, 1.0);
    }

    float sdfCircle(vec2 p, float r) {
        return length(p - 0.5) - r;
    }

    void main() {
      vec2 screenUv = gl_FragCoord.xy / resolution;
      vec2 uv = coverUv(screenUv);

      vec2 gridUv = fract(uv * gridSize);
      vec2 gridUvCenter = (floor(uv * gridSize) + 0.5) / gridSize;

      float trail = texture2D(mouseTrail, gridUvCenter).r;

      gl_FragColor = vec4(pixelColor, trail);
    }
  `
);

const identityEase = (x: number) => x;

function Scene({ gridSize, trailSize, maxAge, interpolate, easingFunction, pixelColor }: SceneProps) {
  const size = useThree(s => s.size);
  const viewport = useThree(s => s.viewport);

  // `transparent: true` is the effect, not a polish flag.
  //
  // The fragment shader writes the trail sample as the ALPHA of every pixel
  // (`gl_FragColor = vec4(pixelColor, trail)`), and three leaves a material
  // OPAQUE unless told otherwise — `shaderMaterial()` supplies no such default.
  // An opaque material takes `NoBlending`, so `WebGLState.setBlending` never
  // reaches `gl.enable(gl.BLEND)` and that alpha modulates nothing: the raw
  // `pixelColor` is written to every pixel of the drawing buffer, including the
  // whole area where the trail is empty and `trail` is 0.
  //
  // The buffer is then composited over the page as PREMULTIPLIED (`alpha: true`
  // plus three's default `premultipliedAlpha: true`), i.e. `src + dst * (1 -
  // srcAlpha)` — so a buffer holding `(pixelColor, 0)` everywhere ADDS
  // `pixelColor` to the whole page. An operator reported precisely that: the
  // panel under a flat magenta veil, readable and unusable.
  //
  // With the flag on, three picks `NormalBlending` and — because
  // `material.premultipliedAlpha` is false, which is three's default and the
  // correct one here, since the shader's colour is NOT premultiplied — the
  // src-over func `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. Against a buffer cleared to
  // (0,0,0,0) that leaves `(pixelColor * trail, trail)`: nothing where the trail
  // is empty, the pixel where it is not, and a correctly premultiplied buffer
  // for the compositor.
  //
  // Do NOT also premultiply in the shader (`vec4(pixelColor * trail, trail)`) —
  // with this blend func that squares the alpha and eats the trail's own edges.
  const dotMaterial = useMemo(() => new DotMaterial({ transparent: true }), []);
  useEffect(() => {
    return () => {
      dotMaterial.dispose();
    };
  }, [dotMaterial]);

  useEffect(() => {
    (dotMaterial.uniforms.pixelColor.value as THREE.Color).set(pixelColor);
  }, [dotMaterial, pixelColor]);

  const [trail, onMove] = useTrailTexture({
    size: 512,
    radius: trailSize,
    maxAge: maxAge,
    interpolate: interpolate || 0.1,
    ease: easingFunction || identityEase
  }) as [THREE.Texture | null, (e: ThreeEvent<PointerEvent>) => void];

  // The `| null` above is defensive typing, not a state this reaches, and it is
  // worth saying so because it reads like a suspect when the screen fills with
  // `pixelColor`: an unbound sampler is undefined behaviour in GLSL and returns
  // 1 on plenty of drivers, which in this shader would be alpha 1 everywhere.
  // It is not what happens. drei's `useTrailTexture` builds the canvas and the
  // `THREE.Texture` synchronously inside its `useMemo`, so the first render
  // already has one; and even if it did not, three never leaves a sampler
  // unbound — `WebGLUniforms.setValueT1` does `textures.setTexture2D(v ||
  // emptyTexture, unit)` and binds its own 1×1. The fill came from the material
  // being opaque, above.
  useEffect(() => {
    if (!trail) return;
    trail.minFilter = THREE.NearestFilter;
    trail.magFilter = THREE.NearestFilter;
    trail.wrapS = THREE.ClampToEdgeWrapping;
    trail.wrapT = THREE.ClampToEdgeWrapping;
  }, [trail]);

  const scale = Math.max(viewport.width, viewport.height) / 2;

  return (
    <mesh scale={[scale, scale, 1]} onPointerMove={onMove}>
      <planeGeometry args={[2, 2]} />
      <primitive
        object={dotMaterial}
        gridSize={gridSize}
        resolution={[size.width * viewport.dpr, size.height * viewport.dpr]}
        mouseTrail={trail}
      />
    </mesh>
  );
}

export default function PixelTrail({
  gridSize = 40,
  trailSize = 0.1,
  maxAge = 250,
  interpolate = 5,
  easingFunction = identityEase,
  canvasProps = {},
  glProps = {
    antialias: false,
    powerPreference: 'high-performance',
    alpha: true
  },
  gooeyFilter,
  color = '#ffffff',
  className = ''
}: PixelTrailProps) {
  const rootRef = useRef<RootState | null>(null);

  // React Three Fiber does release the context on unmount, but from inside a
  // 500 ms setTimeout and without ever calling gl.dispose(). WebKit allows only
  // 16 live WebGL contexts per web-content process before it starts recycling
  // the oldest and handing out an unrecoverable SyntheticLostContext, and this
  // is a GLOBAL cursor effect an operator toggles from a settings page while
  // trying the other seven — so the half-second overlaps itself. Release it
  // here instead, synchronously, while unmounting. Same repair, same reason as
  // Antigravity / Beams / Dither / Silk.
  useEffect(
    () => () => {
      const root = rootRef.current;
      rootRef.current = null;
      if (root === null) return;
      releaseSceneResources(root.scene);
      // dispose() detaches THREE.WebGLRenderer's own webglcontextlost /
      // webglcontextrestored listeners, so the loss below cannot re-enter the
      // restore path and rebuild what we are freeing.
      root.gl.dispose();
      root.gl.forceContextLoss();
    },
    []
  );

  return (
    <>
      {gooeyFilter && <GooeyFilter id={gooeyFilter.id} strength={gooeyFilter.strength} />}
      <Canvas
        {...canvasProps}
        gl={glProps}
        className={`absolute z-1 ${className}`}
        style={gooeyFilter ? { filter: `url(#${gooeyFilter.id})` } : undefined}
        onCreated={state => {
          rootRef.current = state;
          canvasProps.onCreated?.(state);
        }}
      >
        <Scene
          gridSize={gridSize}
          trailSize={trailSize}
          maxAge={maxAge}
          interpolate={interpolate}
          easingFunction={easingFunction}
          pixelColor={color}
        />
      </Canvas>
    </>
  );
}
