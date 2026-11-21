/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { openPluginModal } from "@components/settings/tabs";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { showToast } from "@webpack/common";

import { createRenderer, Renderer } from "./renderer";

// Chromium only, missing from the DOM typings
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack; }) => { readable: ReadableStream<VideoFrame>; };

const logger = new Logger("StreamEnhance");

const settings = definePluginSettings({
    fsr: {
        description: "Escalar con FSR 1 cuando el stream tiene menos resolución que el recuadro donde se ve",
        type: OptionType.BOOLEAN,
        default: true
    },
    sharpness: {
        description: "Nitidez (RCAS de FSR). En 0 queda desactivada",
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 0.3
    },
    deblock: {
        description: "Reducir los bloques, el ruido y los escalones de color de la compresión. En 0 queda desactivado",
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 0.4
    },
    frameGen: {
        description: "Generación de cuadros: inventa cuadros intermedios siguiendo el movimiento para que se vea más fluido (experimental, agrega un cuadro de retraso)",
        type: OptionType.BOOLEAN,
        default: false
    },
    motionBlur: {
        description: "Motion blur en la dirección en que se mueve cada parte de la imagen. En 0 queda desactivado",
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 0
    }
});

interface Enhancer {
    source: MediaStream;
    canvasTrack: CanvasCaptureMediaStreamTrack;
    renderer: Renderer;
    resizeObserver: ResizeObserver;
    reader?: ReadableStreamDefaultReader<VideoFrame>;
    boxWidth: number;
    boxHeight: number;
    arrival: number;
    interval: number;
    lastTimestamp: number;
    presentedT: number;
    animationFrame: number;
}

const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject")!;
const enhancers = new Map<HTMLMediaElement, Enhancer>();
let active = false;

function present(enhancer: Enhancer, t: number) {
    const { renderer, boxWidth, boxHeight } = enhancer;
    if (!boxWidth || !boxHeight) return;
    if (renderer.present(t, settings.store, boxWidth, boxHeight)) {
        enhancer.presentedT = t;
        enhancer.canvasTrack.requestFrame();
    }
}

function onFrame(enhancer: Enhancer, frame: VideoFrame) {
    if (!enhancer.boxWidth || !enhancer.boxHeight) return;
    enhancer.renderer.pushFrame(frame, settings.store);

    // Timestamps come from the sender, so they give a steadier frame interval than arrival times
    if (enhancer.lastTimestamp)
        enhancer.interval = Math.min(Math.max((frame.timestamp - enhancer.lastTimestamp) / 1000, 4), 100);
    enhancer.lastTimestamp = frame.timestamp;
    enhancer.arrival = performance.now();
    enhancer.presentedT = -1;

    if (!settings.store.frameGen) present(enhancer, 1);
}

// With frame generation the newest frame is shown one interval late, the time in between is filled by interpolating
function tick(video: HTMLMediaElement, enhancer: Enhancer) {
    if (enhancers.get(video) !== enhancer) return;
    // Discord doesn't always clear srcObject when a tile unmounts
    if (!video.isConnected) {
        release(video);
        return;
    }
    enhancer.animationFrame = requestAnimationFrame(() => tick(video, enhancer));
    if (!settings.store.frameGen || !enhancer.lastTimestamp) return;

    const t = Math.min((performance.now() - enhancer.arrival) / enhancer.interval, 1);
    if (t !== enhancer.presentedT) present(enhancer, t);
}

async function readFrames(video: HTMLMediaElement, enhancer: Enhancer) {
    try {
        while (enhancers.get(video) === enhancer) {
            // Discord can swap the track inside the same stream, so pick the live one each time the old one ends
            const track = enhancer.source.getVideoTracks().find(t => t.readyState === "live");
            if (!track) break;

            const reader = enhancer.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
            for (; ;) {
                const { value: frame, done } = await reader.read();
                if (done) break;
                try {
                    if (enhancers.get(video) === enhancer) onFrame(enhancer, frame);
                } finally {
                    frame.close();
                }
            }
            // Don't spin if a track keeps ending right away
            await new Promise(r => setTimeout(r, 100));
        }
    } catch (e) {
        logger.error("Processing failed, showing the original stream", e);
    }
    if (enhancers.get(video) === enhancer) release(video);
}

function enhance(video: HTMLVideoElement, source: MediaStream) {
    const canvas = document.createElement("canvas");
    const renderer = createRenderer(canvas);
    const output = canvas.captureStream(0);
    source.getAudioTracks().forEach(track => output.addTrack(track));

    const enhancer: Enhancer = {
        source,
        canvasTrack: output.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack,
        renderer,
        resizeObserver: new ResizeObserver(([entry]) => {
            enhancer.boxWidth = entry.contentRect.width * devicePixelRatio;
            enhancer.boxHeight = entry.contentRect.height * devicePixelRatio;
        }),
        boxWidth: video.clientWidth * devicePixelRatio,
        boxHeight: video.clientHeight * devicePixelRatio,
        arrival: 0,
        interval: 1000 / 30,
        lastTimestamp: 0,
        presentedT: -1,
        animationFrame: 0
    };

    // dispose() also fires this, later, when a newer enhancer may already own the video
    canvas.addEventListener("webglcontextlost", () => {
        if (enhancers.get(video) === enhancer) release(video);
    });
    enhancer.resizeObserver.observe(video);
    enhancers.set(video, enhancer);

    srcObject.set!.call(video, output);
    video.play().catch(() => { });
    tick(video, enhancer);
    readFrames(video, enhancer);
}

function release(video: HTMLMediaElement, restore = true) {
    const enhancer = enhancers.get(video);
    if (!enhancer) return;
    enhancers.delete(video);

    cancelAnimationFrame(enhancer.animationFrame);
    enhancer.reader?.cancel().catch(() => { });
    enhancer.resizeObserver.disconnect();
    enhancer.canvasTrack.stop();
    enhancer.renderer.dispose();

    if (restore) {
        srcObject.set!.call(video, enhancer.source);
        video.play().catch(() => { });
    }
}

function hasLiveVideo(value: unknown): value is MediaStream {
    return value instanceof MediaStream && value.getVideoTracks().some(t => t.readyState === "live");
}

function setSource(video: HTMLMediaElement, value: unknown) {
    release(video, false);
    if (video instanceof HTMLVideoElement && hasLiveVideo(value)) {
        try {
            enhance(video, value);
            return;
        } catch (e) {
            logger.error("Could not enhance the stream", e);
        }
    }
    srcObject.set!.call(video, value);
}

// Discord keeps setting srcObject on its own <video>, so the processed stream is swapped in there.
// Reading it back still returns Discord's stream, which keeps its own checks happy.
function install() {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
        configurable: true,
        enumerable: srcObject.enumerable,
        get(this: HTMLMediaElement) {
            return enhancers.get(this)?.source ?? srcObject.get!.call(this);
        },
        set(this: HTMLMediaElement, value: MediaProvider | null) {
            setSource(this, value);
        }
    });

    for (const video of document.querySelectorAll("video")) {
        const current = srcObject.get!.call(video);
        if (hasLiveVideo(current)) setSource(video, current);
    }
    active = true;
}

function uninstall() {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", srcObject);
    for (const video of [...enhancers.keys()]) release(video);
    active = false;
}

function onKeyDown(e: KeyboardEvent) {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.repeat) return;

    if (e.code === "KeyE") {
        e.preventDefault();
        openPluginModal(plugin);
    } else if (e.code === "KeyF") {
        e.preventDefault();
        if (active) uninstall();
        else install();
        showToast({ text: active ? "StreamEnhance activado" : "StreamEnhance desactivado" });
    }
}

const plugin = definePlugin({
    name: "StreamEnhance",
    description: "Mejora los streams: FSR 1, nitidez, anti-bloques, generación de cuadros y motion blur. Ctrl+Shift+E abre estos ajustes y Ctrl+Shift+F lo prende o apaga",
    authors: [{ name: "Ceito", id: 0n }],
    // Este build lo instala CeitoTweaks a pedido del usuario: arranca prendido
    enabledByDefault: true,
    settings,

    start() {
        install();
        window.addEventListener("keydown", onKeyDown, true);
    },

    stop() {
        window.removeEventListener("keydown", onKeyDown, true);
        if (active) uninstall();
    }
});

export default plugin;
