// Interactive WebGL backdrop for the start screen: a shader-drawn wave that
// bends around the cursor. Mouse movement injects velocity into a 64x64
// field, which is blurred, decayed, and uploaded as a texture the shader
// samples to displace its UVs. Ported from the Stacki prototype.
import { useEffect, useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import { welcomeDrawingSize, welcomeFrames, welcomeMotionAllowed } from './welcomeMotion';

const FIELD_SIZE = 64;
const FIELD_LENGTH = FIELD_SIZE * FIELD_SIZE;

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_pos;
varying vec2 v_uv;

void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision highp float;

varying vec2 v_uv;

uniform float u_time;
uniform vec2 u_res;
uniform sampler2D u_field;

const vec3 COL_LIGHT = vec3(0.9921, 0.9098, 0.9686);
const vec3 COL_WAVE  = vec3(0.1059, 0.0118, 0.6353);
const vec3 COL_DARK  = vec3(0.0039, 0.0,    0.0024);

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}

float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
    i.z+vec4(0.0,i1.z,i2.z,1.0))
    +i.y+vec4(0.0,i1.y,i2.y,1.0))
    +i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

float hash(vec2 p){
  vec3 p3=fract(vec3(p.xyx)*0.1031);
  p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}

void main(){
  float t = u_time * 0.6;

  vec4 fieldSample = texture2D(u_field, v_uv);
  vec2 displacement = (fieldSample.rg - 0.5) * 0.45;
  float aspect = u_res.x / u_res.y;
  displacement.x /= aspect;

  vec2 warpedUV = v_uv + displacement;

  float angle = 18.0 * 3.14159 / 180.0;
  vec2 center = vec2(0.5);
  vec2 uv = warpedUV - center;
  uv = vec2(uv.x*cos(angle) - uv.y*sin(angle),
            uv.x*sin(angle) + uv.y*cos(angle));
  uv += center;

  float x = uv.x;
  float y = uv.y;

  float taperRaw = smoothstep(0.15, 0.55, y);
  float taperMult = mix(1.0, taperRaw, 0.52);
  taperMult += smoothstep(0.4, 1.0, y) * 0.52 * 0.4;

  float yNorm = (y - 0.5) * 2.0;
  float arcOffset = -0.43 * (1.0 - yNorm * yNorm) * 0.4;

  float wavePhase = t * 0.8;
  float wave = sin(y * 3.14159 * 1.2 + wavePhase) * 0.15 * taperMult;
  float wave2 = sin(y * 3.14159 * 0.72 + wavePhase * 0.7 + 2.0) * 0.06 * taperMult;

  float gentleN = snoise(vec3(y * 0.8, t * 0.15, 0.0)) * 0.034 * taperMult;
  float breathe = sin(t * 0.5) * 0.06;

  float arcCenter = 0.61 + arcOffset + wave + wave2 + gentleN + breathe;
  float dist = x - arcCenter;

  float halfW = 0.03 * taperMult;
  float soft = 0.23 * taperMult;
  float blur = 2.64;
  float minS = 0.001;

  float sigmaL = max(halfW * (1.0 + soft * 2.5) * 2.0 * blur, minS);
  float sigmaR = max(halfW * (0.8 + soft * 2.0) * 1.8 * blur, minS);
  float s = dist < 0.0 ? sigmaL : sigmaR;
  float waveMask = exp(-dist * dist / (2.0 * s * s)) * taperMult;

  float gradRaw = smoothstep(-halfW - soft * 1.5 * blur, halfW * 0.5 + soft * blur, dist);
  vec3 baseColor = mix(COL_LIGHT, COL_DARK, gradRaw);

  float internalVar = snoise(vec3(uv * 1.5, t * 0.12)) * 0.12 + 0.5;
  vec3 waveColor = COL_WAVE * (0.9 + internalVar * 0.2);

  vec3 col = mix(baseColor, waveColor, waveMask);

  float darkZone = smoothstep(0.0, (halfW * 2.0 + 0.08) * blur, dist);
  col = mix(col, COL_DARK, darkZone);

  vec2 grainUV = v_uv * u_res / 0.7;
  float gr = hash(grainUV + fract(t * 137.456)) * 2.0 - 1.0;
  col += gr * 0.02;
  col.r += (hash(grainUV + fract(t * 78.233)) * 2.0 - 1.0) * 0.004;
  col.b += (hash(grainUV + fract(t * 45.164)) * 2.0 - 1.0) * 0.004;

  col = clamp(col, 0.0, 1.0);
  col = pow(col, vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}
`;

export default function WelcomeBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const memoryGB = 'deviceMemory' in navigator ? navigator.deviceMemory : undefined;
    if (!welcomeMotionAllowed(navigator.hardwareConcurrency, memoryGB)) {
      return;
    }
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let stop: (() => void) | undefined;
    const update = (): void => {
      stop?.();
      stop = undefined;
      canvas.style.visibility = 'hidden';
      if (!motion.matches) {
        stop = welcomeStart(canvas);
      }
    };
    const contextLost = (): void => {
      stop?.();
      stop = undefined;
      canvas.style.visibility = 'hidden';
    };
    motion.addEventListener('change', update);
    canvas.addEventListener('webglcontextlost', contextLost);
    update();
    return () => {
      stop?.();
      motion.removeEventListener('change', update);
      canvas.removeEventListener('webglcontextlost', contextLost);
    };
  }, []);
  return (
    <div className="welcome-bg" aria-hidden="true">
      <canvas ref={canvasRef} className="welcome-bg-canvas" style={{ visibility: 'hidden' }} />
    </div>
  );
}

function welcomeStart(canvas: HTMLCanvasElement): (() => void) | undefined {
  // Reject software/major-caveat rendering rather than spending CPU on decoration.
  const gl = canvas.getContext('webgl', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) {
    return undefined;
  }
  const resources = welcomeResources(gl);
  if (!resources) {
    return undefined;
  }
  return welcomeAnimate(canvas, gl, resources);
}
function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | undefined {
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

function createProgram(gl: WebGLRenderingContext): WebGLProgram | undefined {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) {
      gl.deleteShader(vertexShader);
    }
    if (fragmentShader) {
      gl.deleteShader(fragmentShader);
    }
    return undefined;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return undefined;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return program;
  }

  console.error(gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
  return undefined;
}

interface WelcomeResources {
  readonly program: WebGLProgram;
  readonly buffer: WebGLBuffer;
  readonly fieldTexture: WebGLTexture;
  readonly timeLocation: WebGLUniformLocation;
  readonly resolutionLocation: WebGLUniformLocation;
  readonly fieldLocation: WebGLUniformLocation;
}
function welcomeResources(gl: WebGLRenderingContext): WelcomeResources | undefined {
  const program = createProgram(gl);
  const buffer = gl.createBuffer();
  const fieldTexture = gl.createTexture();
  const positionLocation = program ? gl.getAttribLocation(program, 'a_pos') : -1;
  const timeLocation = program ? gl.getUniformLocation(program, 'u_time') : undefined;
  const resolutionLocation = program ? gl.getUniformLocation(program, 'u_res') : undefined;
  const fieldLocation = program ? gl.getUniformLocation(program, 'u_field') : undefined;

  if (!program || !buffer || !fieldTexture || positionLocation < 0 || !timeLocation || !resolutionLocation || !fieldLocation) {
    if (buffer) {
      gl.deleteBuffer(buffer);
    }
    if (fieldTexture) {
      gl.deleteTexture(fieldTexture);
    }
    if (program) {
      gl.deleteProgram(program);
    }
    return undefined;
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return { program, buffer, fieldTexture, timeLocation, resolutionLocation, fieldLocation };
}
interface WelcomeField {
  readonly fieldX: Float32Array;
  readonly fieldY: Float32Array;
  readonly tempFieldX: Float32Array;
  readonly tempFieldY: Float32Array;
  readonly fieldData: Uint8Array;
}
function welcomeField(): WelcomeField {
  const fieldX = new Float32Array(FIELD_LENGTH);
  const fieldY = new Float32Array(FIELD_LENGTH);
  const temporaryFieldX = new Float32Array(FIELD_LENGTH);
  const temporaryFieldY = new Float32Array(FIELD_LENGTH);
  const fieldData = new Uint8Array(FIELD_LENGTH * 4);

  return { fieldX, fieldY, tempFieldX: temporaryFieldX, tempFieldY: temporaryFieldY, fieldData };
}
interface PointerState {
  readonly mouseX: number;
  readonly mouseY: number;
  readonly lastMoveTime: number;
  readonly cursorSpeed: number;
  readonly velocityX: number;
  readonly velocityY: number;
}
function welcomePointer(previous: PointerState, event: MouseEvent): PointerState {
  const mouseX = event.clientX / window.innerWidth;
  const mouseY = event.clientY / window.innerHeight;
  const moved = previous.mouseX >= 0 && previous.mouseY >= 0;
  const velocityX = moved ? -(mouseX - previous.mouseX) : previous.velocityX;
  const velocityY = moved ? mouseY - previous.mouseY : previous.velocityY;
  return {
    mouseX,
    mouseY,
    velocityX,
    velocityY,
    lastMoveTime: performance.now(),
    cursorSpeed: moved ? Math.hypot(velocityX, velocityY) : previous.cursorSpeed,
  };
}
// This session alone mutates its preallocated field buffers, avoiding per-frame arrays.
function welcomeAnimate(canvasElement: HTMLCanvasElement, gl: WebGLRenderingContext, resources: WelcomeResources): () => void {
  const { fieldTexture, fieldLocation, timeLocation, resolutionLocation, buffer, program } = resources;
  const field = welcomeField();
  let pointer: PointerState = {
    mouseX: -1,
    mouseY: -1,
    lastMoveTime: 0,
    cursorSpeed: 0,
    velocityX: 0,
    velocityY: 0,
  };
  let hasUploadedOnce = false;
  const startTime = performance.now();
  const handleMouseMove = (event: MouseEvent): void => {
    pointer = welcomePointer(pointer, event);
  };
  const render = (now: number) => {
    const { width, height } = welcomeDrawingSize(canvasElement.clientWidth, canvasElement.clientHeight);

    if (canvasElement.width !== width || canvasElement.height !== height) {
      canvasElement.width = width;
      canvasElement.height = height;
      gl.viewport(0, 0, width, height);
    }

    // The cursor field decays to ~0 within a few seconds of the pointer
    // going idle. Once it's quiet, skip the costly 3-pass blur + texture
    // upload (~110k float ops/frame) — but keep drawing at the capped rate so the
    // ambient time-based shader motion continues. Always run at least once
    // so the field texture is initialised before the first draw.
    const fieldActive = now - pointer.lastMoveTime < 4000 || pointer.cursorSpeed > 0.0005;
    if (fieldActive || !hasUploadedOnce) {
      pointer = { ...pointer, cursorSpeed: welcomeUpdate(field, pointer, now) };
      welcomeUpload(gl, fieldTexture, field);
      hasUploadedOnce = true;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
    gl.uniform1i(fieldLocation, 0);
    gl.uniform1f(timeLocation, (now - startTime) / 1000);
    gl.uniform2f(resolutionLocation, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    canvasElement.style.visibility = 'visible';
  };

  document.addEventListener('mousemove', handleMouseMove);
  const stopFrames = welcomeFrames(render);

  return () => {
    stopFrames();
    document.removeEventListener('mousemove', handleMouseMove);
    gl.deleteTexture(fieldTexture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  };
}
function welcomeUpdate(field: WelcomeField, pointer: PointerState, now: number): number {
  const { fieldX, fieldY } = field;
  const { lastMoveTime, mouseX } = pointer;
  let { cursorSpeed } = pointer;
  assert(fieldX.length === FIELD_LENGTH, 'WelcomeBackground: horizontal field has fixed size');
  assert(fieldY.length === FIELD_LENGTH, 'WelcomeBackground: vertical field has fixed size');
  const idle = now - lastMoveTime;
  const idleFraction = Math.min(idle / 3000, 1);
  const decay = 0.997 - idleFraction * idleFraction * 0.06;

  for (let index = 0; index < FIELD_LENGTH; index += 1) {
    fieldX[index] = welcomeFieldValue(fieldX, index) * decay;
    fieldY[index] = welcomeFieldValue(fieldY, index) * decay;
  }

  cursorSpeed *= idle < 80 ? 0.9 : 0.8;

  if (mouseX >= 0 && idle < 80 && cursorSpeed > 0.0005) {
    welcomeInject(field, { ...pointer, cursorSpeed });
  }
  welcomeBlur(field);
  return cursorSpeed;
}
function welcomeInject(field: WelcomeField, pointer: PointerState): void {
  const { fieldX, fieldY } = field;
  const { mouseX, mouseY, cursorSpeed, velocityX, velocityY } = pointer;
  const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
  const centerX = mouseX * FIELD_SIZE;
  const centerY = (1 - mouseY) * FIELD_SIZE;
  const speedNorm = Math.min(cursorSpeed / 0.03, 1);
  const radius = 5 + speedNorm * 9;
  const intensity = 0.02 + speedNorm * 0.13;
  const directionLength = Math.hypot(velocityX, velocityY) || 1;
  const directionX = velocityX / directionLength;
  const directionY = velocityY / directionLength;
  const radiusX = Math.ceil(radius / aspect) + 1;
  const x0 = Math.max(0, Math.floor(centerX - radiusX));
  const x1 = Math.min(FIELD_SIZE - 1, Math.floor(centerX + radiusX));
  const y0 = Math.max(0, Math.floor(centerY - radius));
  const y1 = Math.min(FIELD_SIZE - 1, Math.floor(centerY + radius));
  const radiusSquared = radius * radius;

  for (let gridY = y0; gridY <= y1; gridY += 1) {
    for (let gridX = x0; gridX <= x1; gridX += 1) {
      const dx = (gridX - centerX) * aspect;
      const dy = gridY - centerY;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= radiusSquared) {
        continue;
      }

      const weight = Math.exp(-distanceSquared / (radiusSquared * 0.4)) * intensity;
      const index = gridY * FIELD_SIZE + gridX;
      fieldX[index] = welcomeFieldValue(fieldX, index) + directionX * weight;
      fieldY[index] = welcomeFieldValue(fieldY, index) + directionY * weight;

      const magnitude = Math.hypot(welcomeFieldValue(fieldX, index), welcomeFieldValue(fieldY, index));
      if (magnitude > 0.001) {
        const softMax = magnitude / (1 + magnitude * 5);
        const scale = softMax / magnitude;
        fieldX[index] = welcomeFieldValue(fieldX, index) * scale;
        fieldY[index] = welcomeFieldValue(fieldY, index) * scale;
      }
    }
  }
}
function welcomeBlur(field: WelcomeField): void {
  const { fieldX, fieldY, tempFieldX: temporaryFieldX, tempFieldY: temporaryFieldY } = field;
  for (let pass = 0; pass < 3; pass += 1) {
    temporaryFieldX.fill(0);
    temporaryFieldY.fill(0);

    for (let gridY = 1; gridY < FIELD_SIZE - 1; gridY += 1) {
      for (let gridX = 1; gridX < FIELD_SIZE - 1; gridX += 1) {
        const index = gridY * FIELD_SIZE + gridX;
        const rowAbove = (gridY - 1) * FIELD_SIZE;
        const rowCurrent = gridY * FIELD_SIZE;
        const rowBelow = (gridY + 1) * FIELD_SIZE;

        const sumX =
          welcomeFieldValue(fieldX, rowAbove + gridX - 1) +
          welcomeFieldValue(fieldX, rowAbove + gridX) +
          welcomeFieldValue(fieldX, rowAbove + gridX + 1) +
          welcomeFieldValue(fieldX, rowCurrent + gridX - 1) +
          welcomeFieldValue(fieldX, index) * 2 +
          welcomeFieldValue(fieldX, rowCurrent + gridX + 1) +
          welcomeFieldValue(fieldX, rowBelow + gridX - 1) +
          welcomeFieldValue(fieldX, rowBelow + gridX) +
          welcomeFieldValue(fieldX, rowBelow + gridX + 1);

        const sumY =
          welcomeFieldValue(fieldY, rowAbove + gridX - 1) +
          welcomeFieldValue(fieldY, rowAbove + gridX) +
          welcomeFieldValue(fieldY, rowAbove + gridX + 1) +
          welcomeFieldValue(fieldY, rowCurrent + gridX - 1) +
          welcomeFieldValue(fieldY, index) * 2 +
          welcomeFieldValue(fieldY, rowCurrent + gridX + 1) +
          welcomeFieldValue(fieldY, rowBelow + gridX - 1) +
          welcomeFieldValue(fieldY, rowBelow + gridX) +
          welcomeFieldValue(fieldY, rowBelow + gridX + 1);

        temporaryFieldX[index] = sumX / 10;
        temporaryFieldY[index] = sumY / 10;
      }
    }

    fieldX.set(temporaryFieldX);
    fieldY.set(temporaryFieldY);
  }
}
function welcomeUpload(gl: WebGLRenderingContext, fieldTexture: WebGLTexture, field: WelcomeField): void {
  const { fieldX, fieldY, fieldData } = field;
  for (let index = 0; index < FIELD_LENGTH; index += 1) {
    fieldData[index * 4] = Math.max(0, Math.min(255, Math.floor((welcomeFieldValue(fieldX, index) * 4 + 0.5) * 255)));
    fieldData[index * 4 + 1] = Math.max(0, Math.min(255, Math.floor((welcomeFieldValue(fieldY, index) * 4 + 0.5) * 255)));
    fieldData[index * 4 + 2] = 0;
    fieldData[index * 4 + 3] = 255;
  }

  gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FIELD_SIZE, FIELD_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, fieldData);
}

function welcomeFieldValue(field: Float32Array, index: number): number {
  const value = field[index];
  assert(value !== undefined, 'WelcomeBackground: field index is inside its fixed buffer');
  return value;
}
