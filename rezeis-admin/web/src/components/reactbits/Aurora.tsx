import { useEffect, useRef, useState } from 'react';
import { Renderer, Program, Mesh, Color, Triangle } from 'ogl';

// GLSL ES 1.00 compiles on WebGL1 and WebGL2. OGL can silently fall back to
// WebGL1 when a mobile browser refuses another WebGL2 context, so a 3.00-only
// shader leaves the preview canvas blank on exactly those constrained devices.
const VERT = `attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ), 
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Three fixed colour stops at 0.0 / 0.5 / 1.0, implemented as a plain function
// (NOT a multi-line #define): Safari/iOS's WebGL2 GLSL ES 3.00 preprocessor
// mishandles backslash-continued multi-line macros ("shaderSource: string not
// ASCII"), so the original COLOR_RAMP macro failed to compile on iOS and the
// aurora silently never rendered — while Chrome/Android were fine. Inlining
// also drops the dynamic array indexing iOS is touchy about. Output is
// identical to the original ramp.
vec3 colorRamp3(vec3 c0, vec3 c1, vec3 c2, float factor) {
  float f = clamp(factor, 0.0, 1.0);
  if (f < 0.5) {
    return mix(c0, c1, f / 0.5);
  }
  return mix(c1, c2, (f - 0.5) / 0.5);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  
  vec3 rampColor = colorRamp3(uColorStops[0], uColorStops[1], uColorStops[2], uv.x);
  
  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;
  
  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);
  
  vec3 auroraColor = intensity * rampColor;
  
  gl_FragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`;

interface AuroraProps {
  colorStops?: string[];
  amplitude?: number;
  blend?: number;
  time?: number;
  speed?: number;
}

export default function Aurora(props: AuroraProps) {
  const resolvedProps = {
    colorStops: props.colorStops ?? ['#5227FF', '#7cff67', '#5227FF'],
    amplitude: props.amplitude ?? 1.0,
    blend: props.blend ?? 0.5,
    speed: props.speed ?? 1.0,
    time: props.time,
  };
  const propsRef = useRef(resolvedProps);
  propsRef.current = resolvedProps;

  const ctnDom = useRef<HTMLDivElement>(null);
  // Bumped by `webglcontextrestored` to re-run the effect below. OGL keeps every
  // GL handle inside Renderer/Program/Geometry and caches driver state on the
  // Renderer, none of which survive a context loss and none of which it can
  // reset — so the only honest recovery is to build the whole thing again.
  const [glGeneration, setGlGeneration] = useState(0);

  useEffect(() => {
    const ctn = ctnDom.current;
    if (!ctn) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        alpha: true,
        premultipliedAlpha: true,
        antialias: true
      });
    } catch {
      return;
    }
    const gl = renderer.gl;
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.style.backgroundColor = 'transparent';
    canvas.style.width = '100%';
    canvas.style.height = '100%';

    let program: Program | undefined;

    function resize() {
      if (!ctn) return;
      const width = Math.max(1, Math.floor(ctn.offsetWidth));
      const height = Math.max(1, Math.floor(ctn.offsetHeight));
      renderer.setSize(width, height);
      if (program) {
        program.uniforms.uResolution.value = [width, height];
      }
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(ctn);

    const geometry = new Triangle(gl);
    if (geometry.attributes.uv) {
      delete geometry.attributes.uv;
    }

    const initial = propsRef.current;
    const colorStopsArray = initial.colorStops.map(hex => {
      const c = new Color(hex);
      return [c.r, c.g, c.b];
    });

    program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: initial.amplitude },
        uColorStops: { value: colorStopsArray },
        uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
        uBlend: { value: initial.blend }
      }
    });

    const mesh = new Mesh(gl, { geometry, program });
    ctn.appendChild(canvas);

    let animateId = 0;
    let contextLost = false;
    const update = (t: number) => {
      if (contextLost) return;
      animateId = requestAnimationFrame(update);
      const current = propsRef.current;
      const time = current.time ?? t * 0.01;
      if (program) {
        program.uniforms.uTime.value = time * current.speed * 0.1;
        program.uniforms.uAmplitude.value = current.amplitude;
        program.uniforms.uBlend.value = current.blend;
        program.uniforms.uColorStops.value = current.colorStops.map((hex: string) => {
          const c = new Color(hex);
          return [c.r, c.g, c.b];
        });
        renderer.render({ scene: mesh });
      }
    };

    // Without preventDefault the browser never fires `webglcontextrestored`,
    // so a recoverable loss becomes permanent.
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelAnimationFrame(animateId);
    };
    // Restarting the loop alone would draw with handles the loss detached: the
    // program, the mesh and the renderer's cached driver state all belong to
    // the context that went away, so the frames would land nowhere and the card
    // would stay blank until a reload. Re-running the effect tears this
    // renderer down (freeing its slot) and builds a fresh one, so the count of
    // live contexts stays flat.
    const handleContextRestored = () => {
      setGlGeneration(generation => generation + 1);
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    resize();
    animateId = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(animateId);
      resizeObserver.disconnect();
      // Listeners come off before loseContext, or handleContextRestored would
      // fire during teardown and rebuild everything we are about to free.
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      if (canvas.parentNode === ctn) {
        ctn.removeChild(canvas);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // Every animated prop is read live from `propsRef` inside the frame loop,
    // so nothing but a replaced GL context may rebuild this renderer.
  }, [glGeneration]);

  return <div ref={ctnDom} className="w-full h-full" />;
}
