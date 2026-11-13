"use strict";

const $ = (sel) => document.querySelector(sel);
const SR = 24000;
const FRAME_SECONDS = 0.08;
const LIVE_MAX_COLS = 64;
const MIC_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';

const state = {
  codes: null,
  frames: 0,
  duration: 0,
  source: "rec",
  urls: {},
  peaks: { orig: null, rec: null },
  audio: new Audio(),
  codebookSize: 2016,
  decodeCtx: null,
};

const live = {
  micOn: false,
  running: false,
  stopping: false,
  sessionId: null,
  ac: null,
  stream: null,
  sourceNode: null,
  analyser: null,
  proc: null,
  sink: null,
  waveData: null,
  raf: 0,
  pending: [],
  pendingLen: 0,
  chain: Promise.resolve(),
  nextTime: 0,
  frames: 0,
  tokens: 0,
  encTotalMs: 0,
  decTotalMs: 0,
  cols: [],
  inLevel: 0,
  outLevel: 0,
  wave: [],
  lastWaveAt: 0,
  chunksSent: 0,
  rttMs: 0,
  streamError: "",
  errorTimer: 0,
};

const talk = {
  recording: false,
  busy: false,
  starting: false,
  ac: null,
  stream: null,
  source: null,
  proc: null,
  sink: null,
  chunks: [],
  length: 0,
  startedAt: 0,
  timer: 0,
  modelState: "idle",
  modelTimer: 0,
  currentAudio: null,
  mode: "voice",
  ttsBusy: false,
};

/* ---------- boot ---------- */

init();

async function init() {
  setupTabs();
  setupUpload();
  setupPlayer();
  setupLive();
  setupTalk();
  wireResize();
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    if (health.codebookSize) state.codebookSize = health.codebookSize;
  } catch (_) {
    /* health is cosmetic; the upload call will surface real errors */
  }
  $("#tokenMax").textContent = state.codebookSize - 1;
}

/* ---------- tabs ---------- */

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;
      if (tab.dataset.tab !== "live" && (live.micOn || live.running)) stopLive();
      if (tab.dataset.tab !== "talk") cancelTalk();
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === `tab-${tab.dataset.tab}`);
      });
      if (tab.dataset.tab === "roundtrip") redrawFileCanvases();
      else {
        drawMicWave();
        if (live.cols.length) drawLiveTokens();
      }
      if (tab.dataset.tab === "talk") {
        initTalkModel();
        requestAnimationFrame(redrawTalkWaves);
      }
    });
  });
}

/* ---------- upload ---------- */

function setupUpload() {
  const drop = $("#drop");
  const fileInput = $("#file");

  drop.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    fileInput.click();
  });
  $("#browse").addEventListener("click", (event) => {
    event.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((name) =>
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((name) =>
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      if (name === "dragleave" && drop.contains(event.relatedTarget)) return;
      drop.classList.remove("over");
    })
  );
  drop.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  $("#sample").addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      setStatus("loading", "Fetching the bundled sample…");
      const blob = await fetch("/static/sample.wav").then((r) => r.blob());
      await handleFile(new File([blob], "sample.wav", { type: "audio/wav" }));
    } catch (err) {
      setStatus("error", err.message || "Could not load the sample.");
    }
  });
}

async function handleFile(file) {
  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    setStatus("error", "File is too large (max 50 MB).");
    return;
  }
  setStatus("loading", `Encoding ${file.name}…`);
  $("#results").hidden = true;

  const form = new FormData();
  form.append("file", file);
  try {
    const response = await fetch("/api/roundtrip", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Server error ${response.status}`);
    renderResults(payload);
    setStatus("", "");
  } catch (err) {
    setStatus("error", err.message || "Something went wrong.");
  }
}

function setStatus(kind, message) {
  const box = $("#status");
  if (!kind) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = `status ${kind}`;
  box.innerHTML = "";
  if (kind === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    box.append(spinner);
  }
  box.append(document.createTextNode(message));
}

/* ---------- results ---------- */

function renderResults(data) {
  state.codes = data.codes;
  state.frames = data.frames;
  state.duration = data.durationSec;
  state.codebookSize = data.codebookSize || state.codebookSize;
  $("#tokenMax").textContent = state.codebookSize - 1;

  const compression = Math.round(384 / data.bitrateKbps);
  $("#metrics").innerHTML = [
    metric("Duration", `${data.durationSec}<small>s</small>`, "24 kHz mono"),
    metric("Frames", `${data.frames}`, `${data.tokens} tokens`),
    metric("Bitrate", `${data.bitrateKbps}<small>kbps</small>`, "12 tokens per frame"),
    metric("Compression", `${compression}<small>×</small>`, "vs 384 kbps PCM", true),
    metric("Encode", `${data.encodeMs}<small>ms</small>`, `${data.encodeX}× real time`),
    metric("Decode", `${data.decodeMs}<small>ms</small>`, `${data.decodeX}× real time`),
  ].join("");

  $("#tokenMeta").textContent =
    `${data.frames} frames · ${(data.frames * FRAME_SECONDS).toFixed(1)} s · ${data.tokens} tokens`;

  // audio files
  Object.values(state.urls).forEach((url) => URL.revokeObjectURL(url));
  state.urls = {
    orig: URL.createObjectURL(b64ToBlob(data.originalWav)),
    rec: URL.createObjectURL(b64ToBlob(data.reconstructedWav)),
  };
  state.peaks = { orig: null, rec: null };
  state.source = "rec";
  updateSeg();
  const audio = state.audio;
  audio.pause();
  audio.src = state.urls.rec;
  audio.currentTime = 0;
  $("#play").classList.remove("playing");
  $("#time").innerHTML = `0:00 <i>/ ${fmtTime(data.durationSec)}</i>`;
  $("#playhead").style.left = "0%";

  $("#dlWav").href = state.urls.rec;
  const tokenJson = {
    model: "LiquidAI/Liquid-Codec",
    sampleRate: SR,
    frameRateHz: 1 / FRAME_SECONDS,
    frameSamples: 1920,
    codebookSize: data.codebookSize,
    interleaving: "codes[frame][codebook]",
    durationSec: data.durationSec,
    stats: {
      frames: data.frames,
      tokens: data.tokens,
      bitrateKbps: data.bitrateKbps,
      encodeMs: data.encodeMs,
      decodeMs: data.decodeMs,
      encodeX: data.encodeX,
      decodeX: data.decodeX,
    },
    codes: data.codes,
  };
  const jsonBlob = new Blob([JSON.stringify(tokenJson, null, 2)], { type: "application/json" });
  const oldJson = $("#dlJson").getAttribute("data-url");
  if (oldJson) URL.revokeObjectURL(oldJson);
  const jsonUrl = URL.createObjectURL(jsonBlob);
  $("#dlJson").href = jsonUrl;
  $("#dlJson").setAttribute("data-url", jsonUrl);

  $("#results").hidden = false;
  prepareAudio();

  // give the browser a frame so the canvas has its final width
  requestAnimationFrame(() => {
    drawTokens($("#tokens"), state.codes, { rows: 12 });
  });
}

function metric(label, value, note, hero = false) {
  return `<div class="metric${hero ? " hero-metric" : ""}">
    <span class="label">${label}</span>
    <span class="value">${value}</span>
    <span class="note">${note}</span>
  </div>`;
}

function b64ToBlob(b64, mime = "audio/wav") {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ---------- audio player ---------- */

function setupPlayer() {
  const audio = state.audio;
  $("#play").addEventListener("click", () => {
    if (!state.urls.rec) return;
    if (audio.paused) {
      if (audio.ended || audio.currentTime >= (state.duration || audio.duration) - 0.01) audio.currentTime = 0;
      audio.play().catch(() => setStatus("error", "Playback was blocked by the browser."));
    } else {
      audio.pause();
    }
  });
  audio.addEventListener("play", () => $("#play").classList.add("playing"));
  audio.addEventListener("pause", () => $("#play").classList.remove("playing"));
  audio.addEventListener("timeupdate", updateTime);
  audio.addEventListener("loadedmetadata", updateTime);
  audio.addEventListener("ended", () => $("#play").classList.remove("playing"));

  $("#ab").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-src]");
    if (button && button.dataset.src !== state.source) setSource(button.dataset.src);
  });

  const wave = $("#wave");
  wave.addEventListener("click", (event) => {
    if (!state.duration) return;
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * state.duration;
    updateTime();
  });

  let raf = 0;
  const tick = () => {
    drawPlayhead();
    if (!audio.paused) raf = requestAnimationFrame(tick);
    else cancelAnimationFrame(raf);
  };
  audio.addEventListener("play", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  audio.addEventListener("ended", () => drawPlayhead());
  audio.addEventListener("seeked", drawPlayhead);
}

function setSource(kind) {
  if (!state.urls[kind]) return;
  const audio = state.audio;
  const time = audio.currentTime;
  const wasPlaying = !audio.paused;
  state.source = kind;
  updateSeg();
  drawWave();

  audio.addEventListener(
    "loadedmetadata",
    () => {
      audio.currentTime = Math.min(time, audio.duration || 0);
      if (wasPlaying) audio.play().catch(() => {});
    },
    { once: true }
  );
  audio.src = state.urls[kind];
}

function updateSeg() {
  document.querySelectorAll("#ab button").forEach((button) => {
    button.classList.toggle("on", button.dataset.src === state.source);
  });
  drawWave();
}

function updateTime() {
  const audio = state.audio;
  const total = state.duration || audio.duration || 0;
  $("#time").innerHTML = `${fmtTime(audio.currentTime)} <i>/ ${fmtTime(total)}</i>`;
  drawPlayhead();
}

function drawPlayhead() {
  const total = state.duration || 0;
  const ratio = total ? Math.min(1, state.audio.currentTime / total) : 0;
  $("#playhead").style.left = `${ratio * 100}%`;
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function prepareAudio() {
  try {
    const [orig, rec] = await Promise.all([
      decodePeaks(state.urls.orig),
      decodePeaks(state.urls.rec),
    ]);
    state.peaks = { orig, rec };
    drawWave();
  } catch (err) {
    console.warn("waveform decode failed", err);
  }
}

async function decodePeaks(url) {
  const buffer = await fetch(url).then((r) => r.arrayBuffer());
  if (!state.decodeCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.decodeCtx = new Ctx();
  }
  const decoded = await state.decodeCtx.decodeAudioData(buffer);
  return peaksFromBuffer(decoded.getChannelData(0), 1400);
}

function peaksFromBuffer(data, buckets) {
  const peaks = new Float32Array(buckets * 2);
  const step = data.length / buckets;
  for (let i = 0; i < buckets; i++) {
    let min = 0;
    let max = 0;
    const start = Math.floor(i * step);
    const end = Math.min(data.length, Math.floor((i + 1) * step));
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }
  return peaks;
}

/* ---------- waveform ---------- */

function redrawFileCanvases() {
  if (!state.codes) return;
  drawTokens($("#tokens"), state.codes, { rows: 12 });
  drawWave();
}

function drawWave() {
  const canvas = $("#wave");
  if (!canvas || !state.peaks.orig || !state.peaks.rec) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const height = 190;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const rowH = height / 2;
  drawPeaks(ctx, state.peaks.orig, 0, rowH, width, state.source === "orig", "rgba(112,132,118", "original");
  drawPeaks(ctx, state.peaks.rec, rowH, rowH, width, state.source === "rec", "rgba(184,255,92", "reconstructed");

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath();
  ctx.moveTo(0, rowH);
  ctx.lineTo(width, rowH);
  ctx.stroke();
}

function drawPeaks(ctx, peaks, top, rowH, width, active, colorPrefix, label) {
  const buckets = peaks.length / 2;
  const mid = top + rowH / 2;
  const amp = rowH * 0.42;
  ctx.strokeStyle = `${colorPrefix},${active ? 0.85 : 0.32})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < buckets; i++) {
    const x = (i / (buckets - 1)) * width;
    const min = peaks[i * 2];
    const max = peaks[i * 2 + 1];
    ctx.moveTo(x, mid + min * amp);
    ctx.lineTo(x, mid + max * amp);
  }
  ctx.stroke();

  ctx.fillStyle = active ? `${colorPrefix},0.9)` : "rgba(128,147,138,0.5)";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(label, 10, top + 15);
}

/* ---------- token grid ---------- */

function tokenColor(value, codebookSize) {
  const hue = (value / Math.max(1, codebookSize - 1)) * 330;
  return `hsl(${hue.toFixed(1)} 78% 56%)`;
}

function drawTokens(canvas, codes, options = {}) {
  if (!canvas || !codes) return;
  const rows = options.rows || 12;
  const frames = codes.length;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const rowH = options.rowH || 21;
  const gutter = options.gutter ?? 30;
  const axisH = options.axis === false ? 8 : 24;
  const height = rows * rowH + axisH;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(4, 8, 6, 0.25)";
  ctx.fillRect(0, 0, width, height);

  const cellW = (width - gutter - 2) / Math.max(1, frames);
  const gap = cellW > 5 ? 1 : 0;

  for (let r = 0; r < rows; r++) {
    for (let f = 0; f < frames; f++) {
      const value = codes[f][r];
      ctx.fillStyle = tokenColor(value, state.codebookSize);
      ctx.fillRect(
        gutter + f * cellW,
        r * rowH,
        Math.max(0.4, cellW - gap),
        Math.max(1, rowH - 1)
      );
    }
  }

  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(128,147,138,0.62)";
  ctx.textAlign = "right";
  for (let r = 0; r < rows; r++) {
    if (rowH < 15 && r % 2) continue;
    ctx.fillText(String(r), gutter - 7, r * rowH + rowH / 2 + 3);
  }
  ctx.textAlign = "left";

  if (options.axis !== false && frames > 0) {
    const duration = frames * FRAME_SECONDS;
    const target = Math.max(1, duration / 6);
    const step = [0.5, 1, 2, 5, 10, 15, 30].find((s) => s >= target) || 30;
    ctx.fillStyle = "rgba(128,147,138,0.55)";
    for (let t = 0; t <= duration; t += step) {
      const x = gutter + (t / duration) * (width - gutter - 2);
      if (x > width - 20) continue;
      ctx.fillText(`${t.toFixed(step < 1 ? 1 : 0)}s`, x, height - 7);
    }
  }

  canvas._tokenLayout = { frames, rows, rowH, gutter, cellW, codes };
}

function setupTokenHover() {
  const canvas = $("#tokens");
  const tooltip = $("#tooltip");
  canvas.addEventListener("pointermove", (event) => {
    const layout = canvas._tokenLayout;
    if (!layout || layout.cellW < 2) {
      tooltip.hidden = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const frame = Math.floor((x - layout.gutter) / layout.cellW);
    const row = Math.floor(y / layout.rowH);
    if (frame < 0 || frame >= layout.frames || row < 0 || row >= layout.rows) {
      tooltip.hidden = true;
      return;
    }
    const value = layout.codes[frame][row];
    tooltip.innerHTML = `<b>token ${value}</b><br>codebook ${row} · frame ${frame}<br>${(frame * FRAME_SECONDS).toFixed(2)} s`;
    tooltip.hidden = false;
    const tipW = tooltip.offsetWidth;
    const left = Math.min(window.innerWidth - tipW - 12, event.clientX + 14);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
  });
  canvas.addEventListener("pointerleave", () => {
    tooltip.hidden = true;
  });
}

/* ---------- resize ---------- */

function wireResize() {
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.codes) {
        drawTokens($("#tokens"), state.codes, { rows: 12 });
        drawWave();
      }
      if (live.cols.length) drawLiveTokens();
      drawMicWave();
      redrawTalkWaves();
    }, 140);
  });
  setupTokenHover();
}

/* ---------- live streaming ---------- */

function setupLive() {
  $("#liveBtn").addEventListener("click", () => {
    if (live.micOn || live.stopping) stopLive();
    else startLive();
  });

  setInterval(() => {
    live.inLevel *= 0.82;
    live.outLevel *= 0.82;
    $("#inLevel").style.width = `${Math.min(100, live.inLevel * 260)}%`;
    $("#outLevel").style.width = `${Math.min(100, live.outLevel * 260)}%`;
    if (live.running) {
      const buffered = Math.max(0, live.nextTime - (live.ac?.currentTime || 0));
      $("#liveLag").textContent = `${Math.round(buffered * 1000)} ms`;
    }
    updateLiveMeta();
  }, 120);
  drawMicWave();
}

function setLiveButton(active) {
  const button = $("#liveBtn");
  button.classList.toggle("recording", active);
  button.innerHTML = active
    ? '<span class="pulse"></span><span>Stop microphone</span>'
    : `${MIC_ICON}<span>Start microphone</span>`;
}

function createAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("Web Audio is not supported by this browser.");
  try {
    return new Ctx({ sampleRate: SR });
  } catch (_) {
    return new Ctx();
  }
}

async function startLive() {
  if (live.micOn || live.stopping) return;
  live.streamError = "";
  $("#liveBtn").disabled = true;
  $("#liveStatus").style.color = "";
  $("#liveStatus").textContent = "Requesting microphone…";
  $("#micBadge").textContent = "starting";
  $("#micBadge").classList.remove("on");

  if (!navigator.mediaDevices?.getUserMedia) {
    liveFailed("Microphone capture needs a secure context (localhost or https).");
    return;
  }

  let ac;
  try {
    ac = createAudioContext();
  } catch (err) {
    liveFailed(err.message);
    return;
  }
  const oldAc = live.ac;
  live.ac = ac;
  if (oldAc) oldAc.close().catch(() => {});
  // Create and resume the context before awaiting permission so the gesture is not lost.
  ac.resume().catch(() => {});

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    liveFailed(
      err.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow it in your browser and try again."
        : `Could not open the microphone: ${err.message}`
    );
    return;
  }
  if (live.stopping) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  resetLiveUi();
  live.stream = stream;
  live.micOn = true;
  live.nextTime = 0;
  live.wave = [];
  startCapture();
  startMicWave();
  $("#liveBtn").disabled = false;
  setLiveButton(true);
  $("#micBadge").textContent = "live";
  $("#micBadge").classList.add("on");
  $("#liveStatus").textContent =
    ac.state === "running"
      ? "Microphone live. Connecting to the codec…"
      : `Microphone connected, but audio is suspended. Click Stop, then Start again. (${ac.state})`;
  updateLiveMeta();

  try {
    const response = await fetch("/api/live/start", { method: "POST" });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `Server returned ${response.status}.`);
    }
    const info = await response.json();
    if (!live.micOn || live.stopping) {
      fetch(`/api/live/${info.sessionId}/stop`, { method: "POST" }).catch(() => {});
      return;
    }
    live.sessionId = info.sessionId;
    live.running = true;
    live.chain = Promise.resolve();
    $("#liveStatus").textContent = `Streaming from a ${Math.round(ac.sampleRate / 1000)} kHz microphone — speak normally.`;
  } catch (err) {
    if (live.micOn) {
      showLiveError(`Microphone works, but the codec server is unreachable: ${err.message} The waveform stays live so you can check your input.`);
    }
  }
}

function resetLiveUi() {
  live.frames = 0;
  live.tokens = 0;
  live.encTotalMs = 0;
  live.decTotalMs = 0;
  live.cols = [];
  live.pending = [];
  live.pendingLen = 0;
  live.chain = Promise.resolve();
  live.nextTime = 0;
  live.chunksSent = 0;
  live.rttMs = 0;
  live.wave = [];
  live.lastWaveAt = 0;
  live.streamError = "";
  live.inLevel = 0;
  live.outLevel = 0;
  $("#liveFrames").textContent = "0";
  $("#liveTokens").textContent = "0";
  $("#liveEnc").textContent = "—";
  $("#liveDec").textContent = "—";
  $("#liveLag").textContent = "—";
  $("#liveStatus").textContent = "Requesting microphone…";
  drawLiveTokens();
  drawMicWave();
}

function startCapture() {
  const ac = live.ac;
  const source = ac.createMediaStreamSource(live.stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  // shortcut: ScriptProcessorNode is deprecated but keeps this demo a single static file. Swap for AudioWorklet if this grows.
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const sink = ac.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(proc);
  proc.connect(sink);
  sink.connect(ac.destination);
  live.sourceNode = source;
  live.analyser = analyser;
  live.proc = proc;
  live.sink = sink;
  live.waveData = new Float32Array(analyser.fftSize);

  proc.onaudioprocess = (event) => {
    if (!live.micOn || !live.sessionId) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = resampleTo24k(input, ac.sampleRate);
    live.pending.push(pcm);
    live.pendingLen += pcm.length;
    if (live.pendingLen >= SR * 0.6) flushLiveChunk();
  };
}

function startMicWave() {
  cancelAnimationFrame(live.raf);
  live.lastWaveAt = 0;
  const loop = (ts) => {
    if (!live.micOn || !live.analyser) return;
    live.analyser.getFloatTimeDomainData(live.waveData);
    let peak = 0;
    for (let i = 0; i < live.waveData.length; i++) {
      const value = Math.abs(live.waveData[i]);
      if (value > peak) peak = value;
    }
    live.inLevel = Math.max(live.inLevel, Math.min(1, peak));
    if (ts - live.lastWaveAt > 40) {
      live.lastWaveAt = ts;
      live.wave.push(Math.min(1, peak));
      if (live.wave.length > 160) live.wave.shift();
      drawMicWave();
    }
    live.raf = requestAnimationFrame(loop);
  };
  live.raf = requestAnimationFrame(loop);
}

function drawMicWave() {
  const canvas = $("#micWave");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const height = 84;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const x = (width / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  const mid = height / 2;
  ctx.strokeStyle = "rgba(128, 147, 138, 0.22)";
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();

  const values = live.wave;
  if (!values.length) {
    ctx.fillStyle = "rgba(128, 147, 138, 0.6)";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(live.micOn ? "listening…" : "microphone off", 10, 16);
    return;
  }

  const cap = 160;
  const step = width / (cap - 1);
  const startX = width - (values.length - 1) * step;
  const amp = mid - 5;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = startX + index * step;
    const y = mid - Math.max(1, value * amp);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let index = values.length - 1; index >= 0; index--) {
    const x = startX + index * step;
    const y = mid + Math.max(1, values[index] * amp);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(184, 255, 92, 0.22)";
  ctx.fill();
  ctx.strokeStyle = "rgba(184, 255, 92, 0.9)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function flushLiveChunk() {
  if (!live.sessionId || !live.pendingLen) return;
  const merged = new Float32Array(live.pendingLen);
  let offset = 0;
  for (const part of live.pending) {
    merged.set(part, offset);
    offset += part.length;
  }
  live.pending = [];
  live.pendingLen = 0;
  enqueueChunk(merged);
}

function enqueueChunk(buffer) {
  const sid = live.sessionId;
  if (!sid) return;
  live.chain = live.chain
    .then(async () => {
      if (live.sessionId !== sid) return;
      const started = performance.now();
      const response = await fetch(`/api/live/${sid}/chunk`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || `Chunk failed (${response.status}).`);
      }
      const message = await response.json();
      live.rttMs = Math.round(performance.now() - started);
      live.chunksSent += 1;
      applyLiveChunk(message);
    })
    .catch((err) => {
      if (live.sessionId === sid) streamFailed(err.message);
    });
}

function resampleTo24k(input, inputRate) {
  if (inputRate === SR) return input.slice();
  const ratio = inputRate / SR;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const frac = pos - base;
    const a = input[base] || 0;
    const b = input[base + 1] ?? a;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

function playPcm16(arrayBuffer) {
  if (!live.ac || !arrayBuffer.byteLength) return;
  const pcm = new Int16Array(arrayBuffer);
  const samples = new Float32Array(pcm.length);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const value = pcm[i] / 32768;
    samples[i] = value;
    if (Math.abs(value) > peak) peak = Math.abs(value);
  }
  live.outLevel = Math.max(live.outLevel, peak);
  const buffer = live.ac.createBuffer(1, samples.length, SR);
  buffer.copyToChannel(samples, 0);
  const node = live.ac.createBufferSource();
  node.buffer = buffer;
  node.connect(live.ac.destination);
  const now = live.ac.currentTime;
  live.nextTime = Math.max(live.nextTime, now + 0.08);
  node.start(live.nextTime);
  live.nextTime += buffer.duration;
}

function playAudioB64(b64) {
  if (!b64 || !live.ac) return;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  playPcm16(bytes.buffer);
}

function applyLiveChunk(message) {
  if (message.audio) playAudioB64(message.audio);
  appendLiveTokens(message.tokens);
  live.frames = message.emittedFrames || live.frames;
  live.tokens = live.frames * 12;
  live.encTotalMs = message.encodeTotalMs ?? live.encTotalMs;
  live.decTotalMs = message.decodeTotalMs ?? live.decTotalMs;
  updateLiveMetrics(message);
  updateLiveMeta();

  if (message.type === "limit") {
    $("#liveStatus").textContent = "20 s cap reached — finishing.";
    stopLive();
    return;
  }
  $("#liveStatus").style.color = "";
  $("#liveStatus").textContent = `Streaming — ${live.frames} frames · ${live.frames * 12} tokens`;
}

function applyLiveDone(message) {
  if (message.audio) playAudioB64(message.audio);
  appendLiveTokens(message.tokens);
  live.frames = message.totalFrames || live.frames;
  live.tokens = live.frames * 12;
  live.encTotalMs = message.encodeTotalMs ?? live.encTotalMs;
  live.decTotalMs = message.decodeTotalMs ?? live.decTotalMs;
  updateLiveMetrics(message);
}

function appendLiveTokens(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return;
  live.cols.push(...tokens);
  if (live.cols.length > LIVE_MAX_COLS) live.cols.splice(0, live.cols.length - LIVE_MAX_COLS);
  drawLiveTokens();
}

function updateLiveMetrics(message) {
  $("#liveFrames").textContent = String(live.frames);
  $("#liveTokens").textContent = String(live.tokens);
  if (message.encodeMs !== undefined) $("#liveEnc").textContent = `${message.encodeMs} ms`;
  if (message.decodeMs !== undefined) $("#liveDec").textContent = `${message.decodeMs} ms`;
}

function updateLiveMeta() {
  const bits = [];
  if (live.micOn) bits.push(`mic ${Math.round((live.ac?.sampleRate || SR) / 1000)} kHz`);
  if (live.chunksSent) bits.push(`${live.chunksSent} chunks sent`);
  if (live.rttMs) bits.push(`last HTTP ${live.rttMs} ms`);
  $("#micMeta").textContent = bits.length ? bits.join(" · ") : "Microphone off.";
}

function stopLive() {
  if (live.stopping) return;
  if (!live.micOn && !live.running) {
    setLiveButton(false);
    $("#liveBtn").disabled = false;
    $("#liveStatus").textContent = "Microphone off.";
    return;
  }
  live.stopping = true;
  live.micOn = false;
  $("#liveBtn").disabled = true;
  stopMicCapture();
  if (live.pendingLen) flushLiveChunk();
  const sid = live.sessionId;
  $("#liveStatus").style.color = "";
  $("#liveStatus").textContent = "Finishing the stream…";

  live.chain = live.chain
    .then(async () => {
      if (!sid) return;
      const response = await fetch(`/api/live/${sid}/stop`, { method: "POST" });
      if (!response.ok) throw new Error(`Stop failed (${response.status}).`);
      applyLiveDone(await response.json());
    })
    .catch((err) => {
      live.streamError = err.message;
    })
    .finally(() => {
      live.sessionId = null;
      live.running = false;
      live.stopping = false;
      live.pending = [];
      live.pendingLen = 0;
      live.nextTime = 0;
      $("#liveBtn").disabled = false;
      $("#micBadge").textContent = "off";
      $("#micBadge").classList.remove("on");
      $("#liveLag").textContent = "—";
      cancelAnimationFrame(live.raf);
      live.raf = 0;
      setLiveButton(false);
      drawMicWave();
      updateLiveMeta();
      if (live.streamError) {
        showLiveError(`Stream stopped: ${live.streamError}`);
      } else if (live.frames) {
        const seconds = (live.frames * FRAME_SECONDS).toFixed(1);
        $("#liveStatus").textContent = `Stopped at ${live.frames} frames (${seconds} s). Encode ${live.encTotalMs} ms · decode ${live.decTotalMs} ms.`;
      } else {
        $("#liveStatus").textContent = "Microphone off.";
      }
    });
}

function stopMicCapture() {
  cancelAnimationFrame(live.raf);
  live.raf = 0;
  if (live.proc) {
    live.proc.onaudioprocess = null;
    live.proc.disconnect();
    live.proc = null;
  }
  if (live.sourceNode) {
    live.sourceNode.disconnect();
    live.sourceNode = null;
  }
  if (live.analyser) {
    live.analyser.disconnect();
    live.analyser = null;
  }
  if (live.sink) {
    live.sink.disconnect();
    live.sink = null;
  }
  if (live.stream) {
    live.stream.getTracks().forEach((track) => track.stop());
    live.stream = null;
  }
  live.waveData = null;
}

function streamFailed(message) {
  if (live.stopping) {
    live.streamError = message;
    return;
  }
  const sid = live.sessionId;
  live.sessionId = null;
  live.running = false;
  live.pending = [];
  live.pendingLen = 0;
  if (sid) fetch(`/api/live/${sid}/stop`, { method: "POST" }).catch(() => {});
  if (live.micOn) {
    showLiveError(`Stream failed: ${message} The microphone is still live — click Stop to release it.`);
    updateLiveMeta();
  } else {
    liveFailed(message);
  }
}

function liveFailed(message) {
  stopMicCapture();
  live.micOn = false;
  live.running = false;
  live.stopping = false;
  live.sessionId = null;
  live.pending = [];
  live.pendingLen = 0;
  if (live.ac) {
    live.ac.close().catch(() => {});
    live.ac = null;
  }
  setLiveButton(false);
  $("#liveBtn").disabled = false;
  $("#micBadge").textContent = "off";
  $("#micBadge").classList.remove("on");
  $("#micMeta").textContent = "Microphone off.";
  drawMicWave();
  showLiveError(message);
}

function showLiveError(message) {
  const el = $("#liveStatus");
  el.textContent = message;
  el.style.color = "var(--danger)";
  clearTimeout(live.errorTimer);
  live.errorTimer = setTimeout(() => {
    el.style.color = "";
  }, 8000);
}

function drawLiveTokens() {
  const canvas = $("#liveTokensCanvas");
  if (!canvas) return;
  const rows = 12;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const height = 190;
  const gutter = 26;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const rowH = (height - 6) / rows;
  const cellW = (width - gutter) / LIVE_MAX_COLS;
  const cols = live.cols;

  ctx.fillStyle = "rgba(255,255,255,0.015)";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < LIVE_MAX_COLS; c += 10) {
      ctx.fillRect(gutter + c * cellW, r * rowH + rowH - 1, cellW * 10, 1);
    }
  }

  const startCol = LIVE_MAX_COLS - cols.length;
  for (let i = 0; i < cols.length; i++) {
    const frame = cols[i];
    for (let r = 0; r < rows; r++) {
      ctx.fillStyle = tokenColor(frame[r], state.codebookSize);
      ctx.fillRect(gutter + (startCol + i) * cellW, r * rowH, Math.max(1, cellW - 1), Math.max(1, rowH - 1));
    }
  }

  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(128,147,138,0.55)";
  for (const r of [0, 3, 6, 9]) ctx.fillText(String(r), 2, r * rowH + rowH / 2 + 3);
}

/* ---------- talk to LFM3-Audio ---------- */

function setupTalk() {
  $("#talkBtn").addEventListener("click", () => {
    if (talk.recording) stopTalk();
    else startTalk();
  });
  $("#talkRetry").addEventListener("click", () => initTalkModel(true));
  document.querySelectorAll("#talkModeToggle button").forEach((button) => {
    button.addEventListener("click", () => setTalkMode(button.dataset.mode));
  });
  $("#ttsSpeakBtn").addEventListener("click", sendTts);
  $("#ttsText").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendTts();
  });
  $("#ttsText").addEventListener("input", updateTtsControls);
  setTalkMode("voice");
}

function setTalkMode(mode) {
  talk.mode = mode === "tts" ? "tts" : "voice";
  const tts = talk.mode === "tts";
  $("#talkHead").hidden = tts;
  $("#ttsPanel").hidden = !tts;
  document.querySelectorAll("#talkModeToggle button").forEach((button) => {
    const active = button.dataset.mode === talk.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  updateTtsControls();
}

function updateTtsControls() {
  const enabled = talk.modelState === "ready" && !talk.ttsBusy;
  $("#ttsSpeakBtn").disabled = !enabled || !$("#ttsText").value.trim();
  $("#ttsText").disabled = !enabled;
  $("#ttsVoice").disabled = !enabled;
}

function setTalkButton(active) {
  const button = $("#talkBtn");
  button.classList.toggle("recording", active);
  button.innerHTML = active
    ? '<span class="pulse"></span><span>Stop &amp; get answer</span>'
    : `${MIC_ICON}<span>Start recording</span>`;
}

function setTalkModelState(kind, message) {
  talk.modelState = kind;
  const box = $("#talkModel");
  box.className = `talk-model ${kind}`;
  $("#talkModelText").textContent = message;
  $("#talkRetry").hidden = kind !== "error";
  $("#talkBtn").disabled = kind !== "ready";
  updateTtsControls();
}

async function initTalkModel(force = false) {
  if (talk.modelState === "loading") return;
  if (talk.modelState === "ready" && !force) return;

  setTalkModelState("loading", "Checking the model…");
  try {
    const status = await fetch("/api/talk/status").then((r) => r.json());
    if (status.state === "ready") {
      talk.modelState = "ready";
      setTalkModelState(
        "ready",
        `LFM3-Audio-2B ready · 4-bit MLX${status.loadMs ? ` · ${(status.loadMs / 1000).toFixed(1)} s load` : ""}`
      );
      return;
    }
  } catch (_) {
    /* the load request below reports the real error */
  }

  setTalkModelState("loading", "Loading LFM3-Audio-2B 4-bit (1.8 GB)…");
  const started = performance.now();
  clearInterval(talk.modelTimer);
  talk.modelTimer = setInterval(() => {
    if (talk.modelState !== "loading") return;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    $("#talkModelText").textContent = `Loading LFM3-Audio-2B 4-bit (1.8 GB)… ${seconds} s`;
  }, 250);

  try {
    const response = await fetch("/api/talk/load", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Server returned ${response.status}.`);
    const ms = payload.loadMs || Math.round(performance.now() - started);
    talk.modelState = "ready";
    setTalkModelState("ready", `LFM3-Audio-2B ready · 4-bit MLX · ${(ms / 1000).toFixed(1)} s load`);
  } catch (err) {
    setTalkModelState("error", `Model failed to load: ${err.message}`);
  } finally {
    clearInterval(talk.modelTimer);
    talk.modelTimer = 0;
  }
}

function setTalkStatus(kind, message) {
  const box = $("#talkStatus");
  if (!kind) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = `status ${kind}`;
  box.innerHTML = "";
  if (kind === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    box.append(spinner);
  }
  const text = document.createElement("span");
  text.id = "talkStatusText";
  text.textContent = message;
  box.append(text);
}

async function startTalk() {
  if (talk.recording || talk.busy || talk.starting) return;
  if (talk.modelState !== "ready") return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setTalkStatus("error", "Microphone capture needs a secure context (localhost or https).");
    return;
  }
  talk.starting = true;
  $("#talkBtn").disabled = true;

  let ac;
  try {
    ac = createAudioContext();
  } catch (err) {
    talk.starting = false;
    $("#talkBtn").disabled = false;
    setTalkStatus("error", err.message);
    return;
  }
  talk.ac = ac;
  ac.resume().catch(() => {});

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    talk.starting = false;
    talk.ac = null;
    ac.close().catch(() => {});
    $("#talkBtn").disabled = false;
    setTalkStatus(
      "error",
      err.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow it in your browser and try again."
        : `Could not open the microphone: ${err.message}`
    );
    return;
  }

  talk.starting = false;
  $("#talkBtn").disabled = false;
  if (!$("#tab-talk").classList.contains("active")) {
    stream.getTracks().forEach((track) => track.stop());
    ac.close().catch(() => {});
    talk.ac = null;
    return;
  }
  talk.stream = stream;
  talk.source = ac.createMediaStreamSource(stream);
  // shortcut: ScriptProcessorNode keeps this demo a single static file. Swap for AudioWorklet if this grows.
  talk.proc = ac.createScriptProcessor(4096, 1, 1);
  talk.sink = ac.createGain();
  talk.sink.gain.value = 0;
  talk.source.connect(talk.proc);
  talk.proc.connect(talk.sink);
  talk.sink.connect(ac.destination);

  const chunks = [];
  talk.proc.onaudioprocess = (event) => {
    if (!talk.recording) return;
    const pcm = resampleTo24k(event.inputBuffer.getChannelData(0), ac.sampleRate);
    chunks.push(pcm);
    talk.length += pcm.length;
  };

  talk.chunks = chunks;
  talk.length = 0;
  talk.recording = true;
  talk.startedAt = performance.now();
  setTalkButton(true);
  setTalkStatus("recording", "Recording… click Stop when you're done.");
  clearInterval(talk.timer);
  talk.timer = setInterval(() => {
    if (!talk.recording) return;
    const el = $("#talkStatusText");
    if (!el) return;
    const seconds = (performance.now() - talk.startedAt) / 1000;
    el.textContent = `Recording ${seconds.toFixed(1)} s — click Stop when you're done.`;
  }, 200);
}

function stopTalk() {
  if (!talk.recording) return;
  const seconds = (performance.now() - talk.startedAt) / 1000;
  talk.recording = false;
  clearInterval(talk.timer);
  talk.timer = 0;
  stopTalkCapture();
  setTalkButton(false);

  const samples = mergeTalkChunks();
  talk.chunks = [];
  if (samples.length < SR * 0.3) {
    talk.length = 0;
    setTalkStatus("error", "That was too short — hold on, speak, then click Stop.");
    return;
  }
  const blob = encodeWav(samples, SR);
  appendUserTurn(blob, samples);
  sendTalk(blob, Math.min(seconds, samples.length / SR));
}

function cancelTalk() {
  if (!talk.recording) return;
  talk.recording = false;
  clearInterval(talk.timer);
  talk.timer = 0;
  stopTalkCapture();
  talk.chunks = [];
  talk.length = 0;
  setTalkButton(false);
  setTalkStatus("", "");
}

function stopTalkCapture() {
  if (talk.proc) {
    talk.proc.onaudioprocess = null;
    talk.proc.disconnect();
    talk.proc = null;
  }
  if (talk.source) {
    talk.source.disconnect();
    talk.source = null;
  }
  if (talk.sink) {
    talk.sink.disconnect();
    talk.sink = null;
  }
  if (talk.stream) {
    talk.stream.getTracks().forEach((track) => track.stop());
    talk.stream = null;
  }
  if (talk.ac) {
    talk.ac.close().catch(() => {});
    talk.ac = null;
  }
}

function mergeTalkChunks() {
  const samples = new Float32Array(talk.length);
  let offset = 0;
  for (const part of talk.chunks) {
    samples.set(part, offset);
    offset += part.length;
  }
  talk.length = 0;
  return samples;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

async function sendTalk(blob, seconds) {
  talk.busy = true;
  $("#talkBtn").disabled = true;
  setTalkStatus("loading", `Thinking… ${seconds.toFixed(1)} s recorded.`);
  const form = new FormData();
  form.append("file", blob, "question.wav");
  try {
    const response = await fetch("/api/talk", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Server error ${response.status}`);
    appendBotTurn(payload);
    setTalkStatus("", "");
  } catch (err) {
    setTalkStatus("error", err.message || "Something went wrong.");
  } finally {
    talk.busy = false;
    $("#talkBtn").disabled = talk.modelState !== "ready";
  }
}

/* ---------- talk chat bubbles ---------- */

const PLAY_ICONS =
  '<svg class="i-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13L19 12 8 5.5Z"/></svg>' +
  '<svg class="i-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

function appendUserTurn(blob, samples) {
  const seconds = samples.length / SR;
  const turn = document.createElement("article");
  turn.className = "turn user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const row = document.createElement("div");
  row.className = "voice-row";
  const button = talkPlayButton("Play your recording");
  const canvas = document.createElement("canvas");
  canvas.className = "bubble-wave";
  canvas.setAttribute("aria-hidden", "true");
  row.append(button, canvas);

  const foot = document.createElement("div");
  foot.className = "bubble-foot";
  foot.innerHTML = `<span>You</span><span>${fmtTime(seconds)}</span>`;
  bubble.append(row, foot);
  turn.append(bubble);
  appendTurn(turn);

  wireVoice(button, canvas, URL.createObjectURL(blob), ampsFromSamples(samples, 120), "user");
}

async function sendTts() {
  if (talk.ttsBusy || talk.modelState !== "ready") return;
  const field = $("#ttsText");
  const voice = $("#ttsVoice").value;
  const text = field.value.trim();
  if (!text) return;

  talk.ttsBusy = true;
  updateTtsControls();
  $("#ttsSpeakBtn").textContent = "Speaking…";
  setTalkStatus("loading", `Reading ${text.length > 60 ? "your text" : `"${text.slice(0, 60)}"`} …`);
  appendTextTurn(text);

  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Server error ${response.status}`);
    appendBotTurn(payload, { label: `LFM3-Audio · ${voice} voice`, download: "lfm3-tts.wav" });
    field.value = "";
    setTalkStatus("", "");
  } catch (err) {
    setTalkStatus("error", err.message || "Something went wrong.");
  } finally {
    talk.ttsBusy = false;
    $("#ttsSpeakBtn").textContent = "Speak";
    updateTtsControls();
  }
}

function appendTextTurn(text) {
  const turn = document.createElement("article");
  turn.className = "turn user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const paragraph = document.createElement("p");
  paragraph.className = "bubble-text";
  paragraph.textContent = text;
  bubble.append(paragraph);
  const foot = document.createElement("div");
  foot.className = "bubble-foot";
  foot.innerHTML = "<span>You</span>";
  bubble.append(foot);
  turn.append(bubble);
  appendTurn(turn);
}

function appendBotTurn(payload, options) {
  const label = options?.label || "LFM3-Audio";
  const download = options?.download || "lfm3-reply.wav";
  const blob = b64ToBlob(payload.replyWav);
  const url = URL.createObjectURL(blob);
  const turn = document.createElement("article");
  turn.className = "turn bot";
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (payload.text && payload.text.trim()) {
    const text = document.createElement("p");
    text.className = "bubble-text";
    text.textContent = payload.text;
    bubble.append(text);
  }

  const row = document.createElement("div");
  row.className = "voice-row";
  const button = talkPlayButton("Play the answer");
  const canvas = document.createElement("canvas");
  canvas.className = "bubble-wave";
  canvas.setAttribute("aria-hidden", "true");
  row.append(button, canvas);

  const foot = document.createElement("div");
  foot.className = "bubble-foot";
  foot.innerHTML =
    `<span>${label} · ${fmtTime(payload.audioSec)}</span>` +
    `<span>${payload.tokens} tokens · ${payload.generateMs} ms</span>` +
    `<a href="${url}" download="${download}">WAV</a>`;
  bubble.append(row, foot);
  if (payload.finishReason === "length") {
    const warn = document.createElement("p");
    warn.className = "bubble-warn";
    warn.textContent = "Reply hit the token cap — its end may be cut off.";
    bubble.append(warn);
  }
  turn.append(bubble);
  appendTurn(turn);

  wireVoice(button, canvas, url, null, "bot", true);
  decodeBlobPeaks(blob, 120)
    .then((peaks) => {
      canvas._wave.peaks = peaks;
      drawBubbleWave(canvas);
    })
    .catch(() => {
      /* playback still works without a drawn waveform */
    });
}

function talkPlayButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bubble-play";
  button.setAttribute("aria-label", label);
  button.innerHTML = PLAY_ICONS;
  return button;
}

function appendTurn(turn) {
  const chat = $("#talkChat");
  chat.append(turn);
  $("#talkEmpty").hidden = true;
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

function wireVoice(button, canvas, url, peaks, theme, autoplay = false) {
  const audio = new Audio(url);
  canvas._wave = { peaks, theme, progress: 0 };
  const draw = () => drawBubbleWave(canvas);

  button.addEventListener("click", () => {
    if (audio.paused) {
      if (talk.currentAudio && talk.currentAudio !== audio) talk.currentAudio.pause();
      talk.currentAudio = audio;
      if (audio.ended) audio.currentTime = 0;
      audio.play().catch(() => setTalkStatus("error", "Playback was blocked by the browser."));
    } else {
      audio.pause();
    }
  });
  audio.addEventListener("play", () => button.classList.add("playing"));
  audio.addEventListener("pause", () => button.classList.remove("playing"));
  audio.addEventListener("ended", () => {
    button.classList.remove("playing");
    canvas._wave.progress = 0;
    draw();
  });
  audio.addEventListener("timeupdate", () => {
    canvas._wave.progress = audio.duration ? audio.currentTime / audio.duration : 0;
    draw();
  });
  requestAnimationFrame(draw);

  if (autoplay) {
    if (talk.currentAudio && talk.currentAudio !== audio) talk.currentAudio.pause();
    talk.currentAudio = audio;
    audio.play().catch(() => {
      /* autoplay may be blocked; the bubble's play button is right there */
    });
  }
}

function ampsFromSamples(samples, buckets) {
  const peaks = peaksFromBuffer(samples, buckets);
  const amps = new Float32Array(buckets);
  let max = 0;
  for (let i = 0; i < buckets; i++) {
    const amp = Math.max(Math.abs(peaks[i * 2]), Math.abs(peaks[i * 2 + 1]));
    amps[i] = amp;
    if (amp > max) max = amp;
  }
  const gain = max > 0.001 ? 1 / max : 0;
  for (let i = 0; i < buckets; i++) amps[i] = Math.min(1, amps[i] * gain);
  return amps;
}

function drawBubbleWave(canvas) {
  const data = canvas._wave;
  if (!data || !data.peaks) return;
  const width = canvas.clientWidth;
  if (!width) return;
  const height = 32;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const peaks = data.peaks;
  const step = width / peaks.length;
  const barW = Math.max(1, step - (step > 3 ? 2 : 0.5));
  const played = data.theme === "user" ? "#eaffc4" : "#b8ff5c";
  const unplayed = data.theme === "user" ? "rgba(184, 255, 92, 0.35)" : "rgba(128, 147, 138, 0.4)";
  for (let i = 0; i < peaks.length; i++) {
    const amp = Math.max(0.06, peaks[i]);
    const h = Math.max(2, amp * (height - 4));
    ctx.fillStyle = (i + 0.5) / peaks.length <= data.progress ? played : unplayed;
    ctx.fillRect(i * step, (height - h) / 2, barW, h);
  }
}

function redrawTalkWaves() {
  document.querySelectorAll("#talkChat .bubble-wave").forEach(drawBubbleWave);
}

async function decodeBlobPeaks(blob, buckets) {
  if (!state.decodeCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.decodeCtx = new Ctx();
  }
  const buffer = await blob.arrayBuffer();
  const decoded = await state.decodeCtx.decodeAudioData(buffer);
  return ampsFromSamples(decoded.getChannelData(0), buckets);
}

