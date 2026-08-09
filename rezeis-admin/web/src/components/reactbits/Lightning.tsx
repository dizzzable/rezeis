import React, { useRef, useEffect } from 'react';

import { resolveBufferRatio } from './render-scale';

interface LightningProps {
  hue?: number;
  xOffset?: number;
  speed?: number;
  intensity?: number;
  size?: number;
}

const Lightning: React.FC<LightningProps> = ({ hue = 230, xOffset = 0, speed = 1, intensity = 1, size = 1 }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Live prop bag: the render loop reads THIS, never the closure.
   *
   * WHAT WENT WRONG. The effect below used to depend on
   * `[hue, xOffset, speed, intensity, size]`. Four of those five are operator
   * sliders (`background-controls.ts` → `lightning`: hue, speed, intensity,
   * size; `xOffset` is a prop with no control), and `LivePreview` in
   * `glass-settings-card.tsx` renders this component with the DRAFT props and
   * no debounce — so a Radix slider drag pushed one full renderer teardown and
   * rebuild per pointer move. Not one of the five reaches anything structural:
   * every one is a `uniform1f` uploaded in `render()` below, the shader source
   * is a constant, and no prop touches the buffer layout or the context
   * attributes. So NONE of them justifies a rebuild, and the dependency array
   * is now empty.
   *
   * Committed in an effect, not written during render: React may replay or
   * discard a render, and a discarded one must not leave the loop reading props
   * from a commit that never happened. No dependency array — every commit,
   * ahead of the effect below. Same idiom as `originkit/Thunderstrike.tsx`.
   */
  const propsRef = useRef({ hue, xOffset, speed, intensity, size });
  useEffect(() => {
    propsRef.current = { hue, xOffset, speed, intensity, size };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /**
     * THE CANVAS IS THIS EFFECT'S, NOT REACT'S.
     *
     * WHAT WENT WRONG. This rendered a `<canvas ref={canvasRef}>` and opened the
     * context on that element. React owns such an element, so it SURVIVES this
     * effect's cleanup — while the cleanup ends by destroying the context living
     * on it. A canvas hands the SAME context object back to every later
     * `getContext` call, lost or not, so a second setup on the same element got
     * the already-lost one: `createShader` returns null on a lost context, the
     * compile bailed with a null info log, and the component returned early to a
     * permanently dead canvas — silently, with nothing thrown for
     * `GlassErrorBoundary` to catch. React StrictMode's double-invoke reproduced
     * it on every dev mount; in production the old dependency array did, on the
     * first slider the operator touched.
     *
     * Allocating the element here makes a second setup impossible to poison by
     * construction: a new element cannot be holding an old context. The
     * `loseContext()` in the cleanup therefore STAYS — WebKit frees a context
     * slot only when the context object is destroyed, and this project is under
     * a 16-per-web-content-process ceiling. Same shape as `Plasma.tsx` and
     * `Grainient.tsx`, the siblings in this directory.
     */
    const canvas = document.createElement('canvas');
    canvas.className = 'block w-full h-full';

    /**
     * Size the drawing buffer, and ONLY when it actually changes.
     *
     * WHAT WENT WRONG: `render()` called this on EVERY frame. Assigning
     * `canvas.width` reallocates the WebGL drawing buffer even when the value
     * is identical, so a full-viewport buffer was being thrown away and
     * rebuilt sixty times a second, forever. The guard makes the per-frame
     * call free, and it is kept there rather than removed because a canvas
     * sized by CSS has no other way to learn it grew.
     *
     * `clientWidth/clientHeight` is the CSS box and stays untouched — this
     * canvas is `w-full h-full` inside the container. Only the buffer is
     * capped, by the same device-pixel budget the rest of the catalog uses;
     * this shader runs a ten-octave fbm per fragment, which is among the most
     * expensive in the catalog full-screen. Everything it draws is a fraction
     * of `iResolution`, so the picture is the same one at a lower sampling
     * density.
     *
     * It is only ever called with the canvas already in the container: a
     * detached element measures 0×0, which would pin the buffer at 1×1 until
     * something else moved.
     */
    const resizeCanvas = () => {
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      const ratio = resolveBufferRatio(cssWidth, cssHeight, 1);
      const width = Math.max(1, Math.floor(cssWidth * ratio));
      const height = Math.max(1, Math.floor(cssHeight * ratio));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
    };

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
    if (!gl) {
      console.error('WebGL not supported');
      // Nothing has been attached or appended yet, so there is nothing to undo.
      return;
    }

    const vertexShaderSource = `
      attribute vec2 aPosition;
      void main() {
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    const fragmentShaderSource = `
      precision mediump float;
      uniform vec2 iResolution;
      uniform float iTime;
      uniform float uHue;
      uniform float uXOffset;
      uniform float uIntensity;
      uniform float uSize;

      #define OCTAVE_COUNT 10

      vec3 hsv2rgb(vec3 c) {
          vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0,4.0,2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return c.z * mix(vec3(1.0), rgb, c.y);
      }

      float hash11(float p) {
          p = fract(p * .1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
      }

      float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * .1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
      }

      mat2 rotate2d(float theta) {
          float c = cos(theta);
          float s = sin(theta);
          return mat2(c, -s, s, c);
      }

      float noise(vec2 p) {
          vec2 ip = floor(p);
          vec2 fp = fract(p);
          float a = hash12(ip);
          float b = hash12(ip + vec2(1.0, 0.0));
          float c = hash12(ip + vec2(0.0, 1.0));
          float d = hash12(ip + vec2(1.0, 1.0));
          
          vec2 t = smoothstep(0.0, 1.0, fp);
          return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
      }

      float fbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.5;
          for (int i = 0; i < OCTAVE_COUNT; ++i) {
              value += amplitude * noise(p);
              p *= rotate2d(0.45);
              p *= 2.0;
              amplitude *= 0.5;
          }
          return value;
      }

      void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
          vec2 uv = fragCoord / iResolution.xy;
          uv = 2.0 * uv - 1.0;
          uv.x *= iResolution.x / iResolution.y;
          uv.x += uXOffset;
          
          uv += 2.0 * fbm(uv * uSize + 0.8 * iTime) - 1.0;

          float dist = abs(uv.x);
          vec3 baseColor = hsv2rgb(vec3(uHue / 360.0, 0.7, 0.8));
          vec3 col = baseColor * pow(mix(0.0, 0.07, hash11(iTime)) / dist, 1.0) * uIntensity;
          col = pow(col, vec3(1.0));
          float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
          fragColor = vec4(col, a);
      }

      void main() {
          mainImage(gl_FragColor, gl_FragCoord.xy);
      }
    `;

    const compileShader = (source: string, type: number): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    // Every bail-out below happens AFTER the context exists, so an unguarded
    // `return` leaves it behind — and a failure here is exactly the situation
    // (a driver under pressure, a recycled context) where leaking one more is
    // least affordable. The canvas is not in the container yet at any of these
    // points, so a failed start also leaves no blank canvas behind for the
    // error boundary or the operator to mistake for a live renderer.
    const abandon = () => {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };

    const vertexShader = compileShader(vertexShaderSource, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(fragmentShaderSource, gl.FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) return abandon;

    const program = gl.createProgram();
    if (!program) return abandon;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program linking error:', gl.getProgramInfoLog(program));
      return abandon;
    }
    gl.useProgram(program);

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    const iResolutionLocation = gl.getUniformLocation(program, 'iResolution');
    const iTimeLocation = gl.getUniformLocation(program, 'iTime');
    const uHueLocation = gl.getUniformLocation(program, 'uHue');
    const uXOffsetLocation = gl.getUniformLocation(program, 'uXOffset');
    const uIntensityLocation = gl.getUniformLocation(program, 'uIntensity');
    const uSizeLocation = gl.getUniformLocation(program, 'uSize');

    // The canvas enters the document only now, with a linked program behind it,
    // and is sized only once it is in — `resizeCanvas` measures a CSS box.
    container.appendChild(canvas);
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    /**
     * The shader clock is INTEGRATED, not multiplied.
     *
     * The shader used to take `iTime` and `uSpeed` and compute `iTime * uSpeed`
     * in two places. That was equivalent while `speed` was fixed for the life of
     * a renderer, which it was — every change rebuilt the renderer and reset
     * `startTime` to zero. Now that speed is live, `t * speed` would jump the
     * whole noise field on every tick of the slider: at t = 60 s a step from 1.0
     * to 1.1 moves the phase by six units, which reads as a hard cut, ~49 of
     * them across the control's range. Accumulating `speed * dt` instead gives
     * the identical picture for any constant speed and a continuous one across a
     * change, so the two uses collapse into a single `iTime` and `uSpeed` is
     * gone from the shader.
     *
     * `dt` is clamped: rAF does not fire in a background tab, so a tab returning
     * after ten minutes would otherwise deliver one enormous step.
     */
    let phase = 0;
    let lastFrameTime = performance.now();
    let destroyed = false;
    // The frame id has to be kept: an unstored requestAnimationFrame cannot be
    // cancelled, so this loop outlived every unmount, held the context and its
    // canvas alive against GC, and went on drawing into a canvas that was no
    // longer in the document. Dormant while the panel background never
    // unmounted; the auth gate now unmounts it on every logout, so it leaked a
    // live full-screen shader per logout — and WebKit allows a web-content
    // process only 16 contexts before it starts recycling the oldest and
    // handing out an unrecoverable SyntheticLostContext.
    let animationFrameId = 0;
    const render = () => {
      if (destroyed) return;
      resizeCanvas();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(iResolutionLocation, canvas.width, canvas.height);

      const currentTime = performance.now();
      const live = propsRef.current;
      phase += Math.min(Math.max(currentTime - lastFrameTime, 0) / 1000, 0.1) * live.speed;
      lastFrameTime = currentTime;

      gl.uniform1f(iTimeLocation, phase);
      gl.uniform1f(uHueLocation, live.hue);
      gl.uniform1f(uXOffsetLocation, live.xOffset);
      gl.uniform1f(uIntensityLocation, live.intensity);
      gl.uniform1f(uSizeLocation, live.size);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animationFrameId = requestAnimationFrame(render);
    };
    animationFrameId = requestAnimationFrame(render);

    return () => {
      destroyed = true;
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resizeCanvas);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(vertexBuffer);
      // The element goes before the context does. A detached canvas is not a
      // presentation, and the panel's canvas observer reads exactly that: a
      // `webglcontextlost` on a canvas still in the document is a fault, one on
      // a canvas that has left it is this teardown.
      try {
        container.removeChild(canvas);
      } catch {
        /* already gone */
      }
      // A dropped reference does not free the context: WebKit only returns the
      // slot when the object is destroyed, and the page hits the 16-context cap
      // long before GC gets there. Modelled on `LiquidChrome.tsx`'s cleanup.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // Empty on purpose — see `propsRef` above. Every prop this component takes
    // is a uniform, so nothing here is structural.
  }, []);

  return <div ref={containerRef} className="w-full h-full relative overflow-hidden" />;
};

export default Lightning;
