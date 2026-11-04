// Real-time WebGL backdrop for the start screen: the launch reel's flowing violet
// noise, drawn on a full-screen triangle. The reel advanced time by frame number;
// here requestAnimationFrame supplies elapsed wall time at the same visual speed.
// Reduced motion or modest hardware gets one still frame. When WebGL is refused
// or lost the canvas stays hidden over .welcome-bg's static gradient, which
// approximates that still frame.
import { useEffect, useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import { welcomeDrawingSize, welcomeFrames, welcomeMotionAllowed } from './welcomeMotion';
import {
  SHADER_FRAGMENT_SOURCE,
  SHADER_LIMITS,
  SHADER_VERTEX_SOURCE,
  welcomeShaderMotion,
  welcomeShaderPixelRatio,
  welcomeShaderSeconds,
  welcomeShaderSurface,
  type WelcomeShaderContext,
} from './welcomeShader';

export default function WelcomeShaderBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const gl = canvas.getContext('webgl', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
      // Software rendering would spend CPU on decoration; the CSS gradient is free.
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) {
      shaderShow(canvas, 'refused');
      return;
    }
    const resources = shaderResources(gl);
    if (!resources) {
      shaderShow(canvas, 'refused');
      return;
    }
    // A missing matchMedia gives no answer about motion; stillness is the safe reading.
    const motion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const memoryGB = 'deviceMemory' in navigator ? navigator.deviceMemory : undefined;
    const hardwareAllowed = welcomeMotionAllowed(navigator.hardwareConcurrency, memoryGB);
    let stop: (() => void) | undefined;
    const update = (): void => {
      stop?.();
      stop = undefined;
      const mode = welcomeShaderMotion({ reducedMotion: motion ? motion.matches : true, hardwareAllowed });
      stop = mode === 'animated' ? shaderAnimate(canvas, gl, resources) : shaderStill(canvas, gl, resources);
    };
    const contextLost = (): void => {
      stop?.();
      stop = undefined;
      shaderShow(canvas, 'lost');
    };
    motion?.addEventListener('change', update);
    canvas.addEventListener('webglcontextlost', contextLost);
    update();
    return () => {
      stop?.();
      motion?.removeEventListener('change', update);
      canvas.removeEventListener('webglcontextlost', contextLost);
      gl.deleteBuffer(resources.buffer);
      gl.deleteProgram(resources.program);
    };
  }, []);
  return (
    <div className="welcome-bg" aria-hidden="true">
      <canvas ref={canvasRef} className="welcome-bg-canvas" style={{ visibility: 'hidden' }} />
    </div>
  );
}

// The one place the canvas is shown or hidden, from the pure surface decision.
function shaderShow(canvasElement: HTMLCanvasElement, context: WelcomeShaderContext): void {
  const surface = welcomeShaderSurface(context);
  canvasElement.style.visibility = surface === 'canvas' ? 'visible' : 'hidden';
}

interface ShaderResources {
  readonly program: WebGLProgram;
  readonly buffer: WebGLBuffer;
  readonly timeLocation: WebGLUniformLocation;
  readonly resolutionLocation: WebGLUniformLocation;
}

function shaderResources(gl: WebGLRenderingContext): ShaderResources | undefined {
  const program = shaderProgram(gl);
  if (!program) {
    return undefined;
  }
  const buffer = gl.createBuffer();
  const positionLocation = gl.getAttribLocation(program, 'a_pos');
  const timeLocation = gl.getUniformLocation(program, 'u_time');
  const resolutionLocation = gl.getUniformLocation(program, 'u_res');
  if (!buffer || positionLocation < 0 || !timeLocation || !resolutionLocation) {
    if (buffer) {
      gl.deleteBuffer(buffer);
    }
    gl.deleteProgram(program);
    return undefined;
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One oversized triangle covers the viewport with no diagonal seam.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  return { program, buffer, timeLocation, resolutionLocation };
}

function shaderProgram(gl: WebGLRenderingContext): WebGLProgram | undefined {
  const vertexShader = shaderCompile(gl, gl.VERTEX_SHADER, SHADER_VERTEX_SOURCE);
  const fragmentShader = shaderCompile(gl, gl.FRAGMENT_SHADER, SHADER_FRAGMENT_SOURCE);
  const program = vertexShader && fragmentShader ? gl.createProgram() : undefined;
  if (program && vertexShader && fragmentShader) {
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
  }
  // A linked program keeps its compiled stages; the shader objects are no longer needed.
  if (vertexShader) {
    gl.deleteShader(vertexShader);
  }
  if (fragmentShader) {
    gl.deleteShader(fragmentShader);
  }
  if (!program) {
    return undefined;
  }
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return program;
  }
  console.error(gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
  return undefined;
}

function shaderCompile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | undefined {
  const shader = gl.createShader(type);
  if (!shader) {
    return undefined;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return shader;
  }
  console.error(gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return undefined;
}

// Returns the draw step as a closure over the canvas it owns; resizing the
// drawing buffer is the one mutation this backdrop makes to its element.
function shaderDrawer(canvasElement: HTMLCanvasElement, gl: WebGLRenderingContext, resources: ShaderResources): (seconds: number) => void {
  return (seconds) => {
    assert(Number.isFinite(seconds), 'WelcomeShaderBackground: shader time must be finite');
    const ratio = welcomeShaderPixelRatio(window.devicePixelRatio);
    // The ratio is capped first, then the shared welcome budget bounds total pixels.
    const { width, height } = welcomeDrawingSize(canvasElement.clientWidth * ratio, canvasElement.clientHeight * ratio);
    if (canvasElement.width !== width || canvasElement.height !== height) {
      canvasElement.width = width;
      canvasElement.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.uniform2f(resources.resolutionLocation, width, height);
    gl.uniform1f(resources.timeLocation, seconds);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    shaderShow(canvasElement, 'drawn');
  };
}

// Owns the frame loop: welcomeFrames caps the rate and pauses while the window
// is hidden or unfocused, so this only maps frame timestamps to shader time.
function shaderAnimate(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, resources: ShaderResources): () => void {
  const draw = shaderDrawer(canvas, gl, resources);
  const startMs = performance.now();
  return welcomeFrames((now) => draw(welcomeShaderSeconds(now - startMs)));
}

// One frame, redrawn only when a resize clears the drawing buffer.
function shaderStill(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, resources: ShaderResources): () => void {
  const drawFrame = shaderDrawer(canvas, gl, resources);
  const draw = (): void => drawFrame(SHADER_LIMITS.secondsStill);
  window.addEventListener('resize', draw);
  draw();
  return () => window.removeEventListener('resize', draw);
}
