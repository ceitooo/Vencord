/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// EASU and RCAS are ports of AMD FidelityFX Super Resolution 1.0, which carries this notice:
//
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

export interface EnhanceOptions {
    fsr: boolean;
    sharpness: number;
    deblock: number;
    frameGen: boolean;
    motionBlur: number;
}

// Motion is searched on a quarter resolution luma copy, in blocks of 8x8 of those pixels
const LUMA_SCALE = 4;
const BLOCK_SIZE = 8;
const MAX_UPSCALE = 2;

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
`;

const COPY = `
uniform sampler2D uTex;
void main() {
    outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`;

// Edge preserving blur: smooths the small steps of compression blocks and banding, keeps real edges
const DEBLOCK = `
uniform sampler2D uTex;
uniform float uStrength;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 last = textureSize(uTex, 0) - 1;
    vec3 center = texelFetch(uTex, p, 0).rgb;
    float range = 0.02 + 0.06 * uStrength;
    vec3 sum = center;
    float total = 1.0;
    for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
            if (x == 0 && y == 0) continue;
            vec3 s = texelFetch(uTex, clamp(p + ivec2(x, y), ivec2(0), last), 0).rgb;
            float d = distance(s, center) / range;
            float w = exp(-0.5 * d * d - float(x * x + y * y) / 4.5);
            sum += s * w;
            total += w;
        }
    }
    outColor = vec4(sum / total, 1.0);
}`;

const LUMA = `
uniform sampler2D uTex;
void main() {
    vec2 size = vec2(textureSize(uTex, 0));
    vec2 base = floor(gl_FragCoord.xy) * ${LUMA_SCALE.toFixed(1)};
    vec3 c = texture(uTex, (base + vec2(1.0, 1.0)) / size).rgb
        + texture(uTex, (base + vec2(3.0, 1.0)) / size).rgb
        + texture(uTex, (base + vec2(1.0, 3.0)) / size).rgb
        + texture(uTex, (base + vec2(3.0, 3.0)) / size).rgb;
    outColor = vec4(dot(c * 0.25, vec3(0.25, 0.5, 0.25)), 0.0, 0.0, 1.0);
}`;

// Block matching. A vector v means the block moved by v since the previous frame, so curr(p) ~ prev(p - v).
// Vectors are stored as (v + 128) / 255, which keeps zero exact in an 8 bit texture.
const MOTION = `
uniform sampler2D uPrev;
uniform sampler2D uCurr;
uniform sampler2D uLast;
ivec2 lastTexel;

float cost(ivec2 base, ivec2 off) {
    float sad = 0.0;
    for (int y = 0; y < ${BLOCK_SIZE}; y += 2) {
        for (int x = 0; x < ${BLOCK_SIZE}; x += 2) {
            ivec2 p = base + ivec2(x, y);
            float c = texelFetch(uCurr, clamp(p, ivec2(0), lastTexel), 0).r;
            float q = texelFetch(uPrev, clamp(p - off, ivec2(0), lastTexel), 0).r;
            sad += abs(c - q);
        }
    }
    // Prefer short vectors so flat areas don't pick random motion
    return sad + 0.002 * float(abs(off.x) + abs(off.y));
}

void main() {
    lastTexel = textureSize(uCurr, 0) - 1;
    ivec2 block = ivec2(gl_FragCoord.xy);
    ivec2 base = block * ${BLOCK_SIZE};

    ivec2 best = ivec2(0);
    float bestCost = cost(base, best) - 0.02;
    for (int y = -16; y <= 16; y += 2) {
        for (int x = -16; x <= 16; x += 2) {
            float c = cost(base, ivec2(x, y));
            if (c < bestCost) {
                bestCost = c;
                best = ivec2(x, y);
            }
        }
    }

    // The coarse search skips every other offset, and the previous vector lets fast pans grow past the window
    ivec2 coarse = best;
    ivec2 predicted = clamp(ivec2(round(texelFetch(uLast, block, 0).rg * 255.0)) - 128, ivec2(-30), ivec2(30));
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            for (int k = 0; k < 2; k++) {
                ivec2 off = (k == 0 ? coarse : predicted) + ivec2(x, y);
                float c = cost(base, off);
                if (c < bestCost) {
                    bestCost = c;
                    best = off;
                }
            }
        }
    }

    outColor = vec4(vec2(best + 128) / 255.0, 0.0, 1.0);
}`;

// Builds the frame at time t between prev (0) and curr (1) by moving both along the motion.
// Where the two warped frames disagree the motion was wrong, so it falls back to the nearest real frame.
const COMPOSITE = `
uniform sampler2D uPrev;
uniform sampler2D uCurr;
uniform sampler2D uMotion;
uniform float uT;
uniform float uBlur;

vec3 warp(vec2 v, float t) {
    vec3 a = texture(uPrev, vUv - t * v).rgb;
    vec3 b = texture(uCurr, vUv + (1.0 - t) * v).rgb;
    vec3 blended = mix(a, b, clamp(t, 0.0, 1.0));
    vec3 nearest = t < 0.5 ? texture(uPrev, vUv).rgb : texture(uCurr, vUv).rgb;
    return mix(blended, nearest, smoothstep(0.08, 0.25, distance(a, b)));
}

void main() {
    vec2 v = (texture(uMotion, vUv).rg * 255.0 - 128.0) * ${LUMA_SCALE.toFixed(1)} / vec2(textureSize(uCurr, 0));
    if (uBlur <= 0.0) {
        outColor = vec4(warp(v, uT), 1.0);
        return;
    }
    vec3 sum = vec3(0.0);
    // The shutter ends at t, looking ahead would mean extrapolating frames that don't exist yet
    for (int i = 0; i < 6; i++) sum += warp(v, uT + (float(i) / 5.0 - 1.0) * uBlur);
    outColor = vec4(sum / 6.0, 1.0);
}`;

const EASU = `
uniform sampler2D uTex;
ivec2 lastTexel;

vec3 tap(ivec2 p) {
    return texelFetch(uTex, clamp(p, ivec2(0), lastTexel), 0).rgb;
}

float luma(vec3 c) {
    return c.g + 0.5 * (c.r + c.b);
}

void edge(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
    float dirX = lD - lB;
    float lenX = clamp(abs(dirX) / max(max(abs(lD - lC), abs(lC - lB)), 1e-5), 0.0, 1.0);
    float dirY = lE - lA;
    float lenY = clamp(abs(dirY) / max(max(abs(lE - lC), abs(lC - lA)), 1e-5), 0.0, 1.0);
    dir += vec2(dirX, dirY) * w;
    len += (lenX * lenX + lenY * lenY) * w;
}

void accumulate(inout vec3 color, inout float weight, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
    vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x))) * len2;
    float d2 = min(dot(v, v), clp);
    float wB = 0.4 * d2 - 1.0;
    float wA = lob * d2 - 1.0;
    float w = (25.0 / 16.0 * wB * wB - (25.0 / 16.0 - 1.0)) * wA * wA;
    color += c * w;
    weight += w;
}

void main() {
    lastTexel = textureSize(uTex, 0) - 1;
    vec2 pp = vUv * vec2(textureSize(uTex, 0)) - 0.5;
    vec2 fp = floor(pp);
    pp -= fp;
    ivec2 p = ivec2(fp);

    //    b c
    //  e f g h
    //  i j k l
    //    n o
    vec3 b = tap(p + ivec2(0, -1)), c = tap(p + ivec2(1, -1));
    vec3 e = tap(p + ivec2(-1, 0)), f = tap(p), g = tap(p + ivec2(1, 0)), h = tap(p + ivec2(2, 0));
    vec3 i = tap(p + ivec2(-1, 1)), j = tap(p + ivec2(0, 1)), k = tap(p + ivec2(1, 1)), l = tap(p + ivec2(2, 1));
    vec3 n = tap(p + ivec2(0, 2)), o = tap(p + ivec2(1, 2));

    float bL = luma(b), cL = luma(c), eL = luma(e), fL = luma(f), gL = luma(g), hL = luma(h);
    float iL = luma(i), jL = luma(j), kL = luma(k), lL = luma(l), nL = luma(n), oL = luma(o);

    vec2 dir = vec2(0.0);
    float len = 0.0;
    edge(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
    edge(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
    edge(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
    edge(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

    float dirR = dot(dir, dir);
    dir = dirR < 1.0 / 32768.0 ? vec2(1.0, 0.0) : dir * inversesqrt(dirR);
    len *= 0.5;
    len *= len;
    float stretch = 1.0 / max(abs(dir.x), abs(dir.y));
    vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
    float lob = 0.5 - 0.29 * len;
    float clp = 1.0 / lob;

    vec3 color = vec3(0.0);
    float weight = 0.0;
    accumulate(color, weight, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
    accumulate(color, weight, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
    accumulate(color, weight, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
    accumulate(color, weight, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
    accumulate(color, weight, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, f);
    accumulate(color, weight, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
    accumulate(color, weight, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
    accumulate(color, weight, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
    accumulate(color, weight, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
    accumulate(color, weight, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
    accumulate(color, weight, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, o);
    accumulate(color, weight, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);

    // Clamping to the nearest 2x2 removes the ringing the negative lobe adds
    vec3 mn = min(min(f, g), min(j, k));
    vec3 mx = max(max(f, g), max(j, k));
    outColor = vec4(clamp(color / weight, mn, mx), 1.0);
}`;

// Last pass, draws to the canvas. Internal textures are top row first, the canvas is bottom row first.
const RCAS = `
uniform sampler2D uTex;
uniform float uSharpness;
uniform float uSeed;
ivec2 lastTexel;

vec3 tap(ivec2 p) {
    return texelFetch(uTex, clamp(p, ivec2(0), lastTexel), 0).rgb;
}

float luma(vec3 c) {
    return c.g + 0.5 * (c.r + c.b);
}

void main() {
    lastTexel = textureSize(uTex, 0) - 1;
    ivec2 p = ivec2(int(gl_FragCoord.x), lastTexel.y - int(gl_FragCoord.y));
    vec3 b = tap(p + ivec2(0, -1));
    vec3 d = tap(p + ivec2(-1, 0));
    vec3 e = tap(p);
    vec3 f = tap(p + ivec2(1, 0));
    vec3 h = tap(p + ivec2(0, 1));

    // Sharpen less where the center pixel looks like compression noise
    float bL = luma(b), dL = luma(d), eL = luma(e), fL = luma(f), hL = luma(h);
    float range = max(max(max(bL, dL), max(fL, hL)), eL) - min(min(min(bL, dL), min(fL, hL)), eL);
    float nz = clamp(abs(0.25 * (bL + dL + fL + hL) - eL) / max(range, 1e-5), 0.0, 1.0);
    nz = 1.0 - 0.5 * nz;

    vec3 mn4 = min(min(b, d), min(f, h));
    vec3 mx4 = max(max(b, d), max(f, h));
    vec3 hitMin = min(mn4, e) / max(4.0 * mx4, 1e-5);
    vec3 hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, -1e-5);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uSharpness * nz;
    vec3 color = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);

    // Half a step of noise hides the banding that 8 bit gradients get after all the filtering
    float noise = fract(sin(dot(gl_FragCoord.xy + uSeed, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    outColor = vec4(color + noise / 255.0, 1.0);
}`;

interface Target {
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    width: number;
    height: number;
}

function compile(gl: WebGL2RenderingContext, fragment: string) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, HEADER + fragment]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
        gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    return program;
}

function createTexture(gl: WebGL2RenderingContext, filter: number) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
}

function createTarget(gl: WebGL2RenderingContext, filter: number): Target {
    const texture = createTexture(gl, filter);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width: 0, height: 0 };
}

function resizeTarget(gl: WebGL2RenderingContext, target: Target, width: number, height: number) {
    if (target.width === width && target.height === height) return;
    target.width = width;
    target.height = height;
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

export type Renderer = ReturnType<typeof createRenderer>;

export function createRenderer(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("webgl2", { antialias: false, depth: false, alpha: false });
    if (!context) throw new Error("WebGL2 is not available");
    const gl: WebGL2RenderingContext = context;

    let programs: Record<"copy" | "deblock" | "luma" | "motion" | "composite" | "easu" | "rcas", WebGLProgram>;
    try {
        programs = {
            copy: compile(gl, COPY),
            deblock: compile(gl, DEBLOCK),
            luma: compile(gl, LUMA),
            motion: compile(gl, MOTION),
            composite: compile(gl, COMPOSITE),
            easu: compile(gl, EASU),
            rcas: compile(gl, RCAS)
        };
    } catch (e) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        throw e;
    }

    const uniform = (program: keyof typeof programs, name: string) => gl.getUniformLocation(programs[program], name);
    const uniforms = {
        deblockStrength: uniform("deblock", "uStrength"),
        compositeT: uniform("composite", "uT"),
        compositeBlur: uniform("composite", "uBlur"),
        rcasSharpness: uniform("rcas", "uSharpness"),
        rcasSeed: uniform("rcas", "uSeed")
    };
    for (const [program, samplers] of [["motion", ["uPrev", "uCurr", "uLast"]], ["composite", ["uPrev", "uCurr", "uMotion"]]] as const) {
        gl.useProgram(programs[program]);
        samplers.forEach((name, unit) => gl.uniform1i(uniform(program, name), unit));
    }

    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const rawTexture = createTexture(gl, gl.NEAREST);
    const frames = [createTarget(gl, gl.LINEAR), createTarget(gl, gl.LINEAR)];
    const lumas = [createTarget(gl, gl.NEAREST), createTarget(gl, gl.NEAREST)];
    const motions = [createTarget(gl, gl.LINEAR), createTarget(gl, gl.LINEAR)];
    const composite = createTarget(gl, gl.LINEAR);
    const upscaled = createTarget(gl, gl.NEAREST);

    let current = 0;
    let hasPrevious = false;
    let previousHasLuma = false;
    let motionReady = false;
    let frameCount = 0;

    function draw(program: WebGLProgram, target: Target | null, width: number, height: number, ...textures: WebGLTexture[]) {
        gl.useProgram(program);
        textures.forEach((texture, unit) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
        });
        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
        gl.viewport(0, 0, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function clearMotion(target: Target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.clearColor(128 / 255, 128 / 255, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    return {
        pushFrame(frame: VideoFrame, options: EnhanceOptions) {
            if (gl.isContextLost()) return;
            const { displayWidth: width, displayHeight: height } = frame;

            if (width !== frames[0].width || height !== frames[0].height) {
                const lumaWidth = Math.ceil(width / LUMA_SCALE);
                const lumaHeight = Math.ceil(height / LUMA_SCALE);
                for (let i = 0; i < 2; i++) {
                    resizeTarget(gl, frames[i], width, height);
                    resizeTarget(gl, lumas[i], lumaWidth, lumaHeight);
                    resizeTarget(gl, motions[i], Math.ceil(lumaWidth / BLOCK_SIZE), Math.ceil(lumaHeight / BLOCK_SIZE));
                    clearMotion(motions[i]);
                }
                resizeTarget(gl, composite, width, height);
                hasPrevious = previousHasLuma = false;
            }

            current ^= 1;
            const previous = current ^ 1;
            const target = frames[current];

            if (options.deblock > 0) {
                gl.bindTexture(gl.TEXTURE_2D, rawTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
                gl.useProgram(programs.deblock);
                gl.uniform1f(uniforms.deblockStrength, options.deblock);
                draw(programs.deblock, target, width, height, rawTexture);
            } else {
                gl.bindTexture(gl.TEXTURE_2D, target.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
            }

            motionReady = false;
            const needsMotion = options.frameGen || options.motionBlur > 0;
            if (needsMotion) {
                const luma = lumas[current];
                draw(programs.luma, luma, luma.width, luma.height, target.texture);
                if (hasPrevious && previousHasLuma) {
                    const motion = motions[current];
                    draw(programs.motion, motion, motion.width, motion.height,
                        lumas[previous].texture, luma.texture, motions[previous].texture);
                    motionReady = true;
                } else {
                    clearMotion(motions[current]);
                }
            }
            previousHasLuma = needsMotion;
            hasPrevious = true;
        },

        // t is the position between the previous frame (0) and the newest one (1)
        present(t: number, options: EnhanceOptions, boxWidth: number, boxHeight: number) {
            if (gl.isContextLost() || !hasPrevious) return false;
            const frame = frames[current];
            const scale = Math.min(Math.max(Math.min(boxWidth / frame.width, boxHeight / frame.height), 1), MAX_UPSCALE);
            const outWidth = Math.round(frame.width * scale);
            const outHeight = Math.round(frame.height * scale);
            if (canvas.width !== outWidth) canvas.width = outWidth;
            if (canvas.height !== outHeight) canvas.height = outHeight;

            let source = frame.texture;
            if (motionReady && (options.frameGen || options.motionBlur > 0)) {
                gl.useProgram(programs.composite);
                gl.uniform1f(uniforms.compositeT, options.frameGen ? t : 1);
                gl.uniform1f(uniforms.compositeBlur, options.motionBlur);
                draw(programs.composite, composite, frame.width, frame.height,
                    frames[current ^ 1].texture, frame.texture, motions[current].texture);
                source = composite.texture;
            }

            resizeTarget(gl, upscaled, outWidth, outHeight);
            draw(options.fsr && scale > 1 ? programs.easu : programs.copy, upscaled, outWidth, outHeight, source);

            gl.useProgram(programs.rcas);
            gl.uniform1f(uniforms.rcasSharpness, options.sharpness);
            gl.uniform1f(uniforms.rcasSeed, frameCount++ % 64);
            draw(programs.rcas, null, outWidth, outHeight, upscaled.texture);
            return true;
        },

        dispose() {
            gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
    };
}
