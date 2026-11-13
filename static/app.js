"use strict";

const $ = (sel) => document.querySelector(sel);
const SR = 24000;
const MIC_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';
const WAVE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<path d="M3 12h2M8 7v10M12 4v16M16 9v6M20 11v2"/></svg>';

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
};

let decodeCtx = null;

const MIC_KEY = "liq-codec.micId";
let selectedMicId = "";
try {
  selectedMicId = localStorage.getItem(MIC_KEY) || "";
} catch (_) {
  /* private mode — selection just won't persist */
}

/* ---------- boot ---------- */

init();

async function init() {
  setupTalk();
  wireResize();
  await refreshMicList();
  $("#micSelect").addEventListener("change", (event) => {
    selectedMicId = event.target.value;
    try {
      localStorage.setItem(MIC_KEY, selectedMicId);
    } catch (_) {
      /* private mode */
    }
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshMicList());
  initTalkModel();
}

async function refreshMicList() {
  const select = $("#micSelect");
  if (!navigator.mediaDevices?.enumerateDevices) {
    $(".mic-pick").hidden = true;
    return;
  }
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    select.innerHTML = "";
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "System default";
    select.append(fallback);
    devices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index + 1}`;
      select.append(option);
    });
    // labels only appear after permission; keep the saved choice if it still exists
    selectedMicId = [...select.options].some((o) => o.value === selectedMicId) ? selectedMicId : "";
    select.value = selectedMicId;
  } catch (_) {
    /* leave the list as-is; the record button surfaces real errors */
  }
}

/* ---------- resize ---------- */

function wireResize() {
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(redrawTalkWaves, 140);
  });
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

function b64ToBlob(b64, mime = "audio/wav") {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
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

/* ---------- talk to LFM3-Audio ---------- */

function setupTalk() {
  $("#talkBtn").addEventListener("click", () => {
    if (talk.recording) stopTalk();
    else startTalk();
  });
  $("#talkRetry").addEventListener("click", () => initTalkModel(true));
}

function setTalkButton(active) {
  const button = $("#talkBtn");
  button.classList.toggle("recording", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.innerHTML = active
    ? '<span class="pulse"></span><span class="record-label">Stop &amp; answer</span>'
    : `${MIC_ICON}<span class="record-label">Record</span>`;
}

function setTalkModelState(kind, message) {
  talk.modelState = kind;
  document.body.dataset.core = kind;
  const box = $("#talkModel");
  box.className = `talk-model ${kind}`;
  $("#talkModelText").textContent = message;
  $("#talkRetry").hidden = kind !== "error";
  $("#talkBtn").disabled = kind !== "ready";
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
        `MODEL READY${status.loadMs ? ` // ${(status.loadMs / 1000).toFixed(1)} S LOAD` : ""}`
      );
      return;
    }
  } catch (_) {
    /* the load request below reports the real error */
  }

  setTalkModelState("loading", "LOADING MODEL // 1.8 GB");
  const started = performance.now();
  clearInterval(talk.modelTimer);
  talk.modelTimer = setInterval(() => {
    if (talk.modelState !== "loading") return;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    $("#talkModelText").textContent = `LOADING MODEL // 1.8 GB // ${seconds} S`;
  }, 1000);

  try {
    const response = await fetch("/api/talk/load", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Server returned ${response.status}.`);
    const ms = payload.loadMs || Math.round(performance.now() - started);
    talk.modelState = "ready";
    setTalkModelState("ready", `MODEL READY // ${(ms / 1000).toFixed(1)} S LOAD`);
  } catch (err) {
    setTalkModelState("error", `LOAD FAILED // ${err.message}`);
  } finally {
    clearInterval(talk.modelTimer);
    talk.modelTimer = 0;
  }
}

function setTalkStatus(kind, message) {
  const box = $("#talkStatus");
  document.body.dataset.state = kind || "idle";
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

/* ---------- audio pipeline ---------- */

function setPipelinePhase(phase) {
  const pipeline = $("#pipeline");
  if (pipeline) pipeline.dataset.phase = phase;
}

function setInputLevel(level) {
  const pipeline = $("#pipeline");
  if (!pipeline) return;
  pipeline.style.setProperty("--level", Math.max(0.15, Math.min(1, level)).toFixed(2));
}

function resetPipeline() {
  setInputLevel(0.15);
  const output = $("#pipelineOutput");
  if (output) output.textContent = "24 kHz PCM";
}

function updatePipeline(payload) {
  const output = $("#pipelineOutput");
  if (output) output.textContent = `${fmtTime(payload.audioSec)} · 24 kHz`;
  setPipelinePhase("output");
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
    setPipelinePhase("idle");
    return;
  }
  talk.ac = ac;
  ac.resume().catch(() => {});

  const audioConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (selectedMicId) audioConstraints.deviceId = { exact: selectedMicId };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    refreshMicList(); // labels are visible now that permission was granted
  } catch (err) {
    talk.starting = false;
    talk.ac = null;
    ac.close().catch(() => {});
    $("#talkBtn").disabled = false;
    setTalkStatus(
      "error",
      err.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow it in your browser and try again."
        : err.name === "OverconstrainedError"
          ? "That microphone is unavailable — pick another one above."
          : `Could not open the microphone: ${err.message}`
    );
    setPipelinePhase("idle");
    return;
  }

  talk.starting = false;
  $("#talkBtn").disabled = false;
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
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / pcm.length);
    setInputLevel(0.15 + Math.min(1, rms * 12) * 0.85);
  };

  talk.chunks = chunks;
  talk.length = 0;
  talk.recording = true;
  talk.startedAt = performance.now();
  resetPipeline();
  setPipelinePhase("recording");
  setTalkButton(true);
  setTalkStatus("recording", "RECORDING // CLICK STOP TO SEND.");
  clearInterval(talk.timer);
  talk.timer = setInterval(() => {
    if (!talk.recording) return;
    const el = $("#talkStatusText");
    if (!el) return;
    const seconds = (performance.now() - talk.startedAt) / 1000;
    el.textContent = `RECORDING ${fmtTime(seconds)} // CLICK STOP TO SEND.`;
  }, 1000);
}

function stopTalk() {
  if (!talk.recording) return;
  const seconds = (performance.now() - talk.startedAt) / 1000;
  talk.recording = false;
  clearInterval(talk.timer);
  talk.timer = 0;
  stopTalkCapture();
  setTalkButton(false);
  setInputLevel(0.15);

  const samples = mergeTalkChunks();
  talk.chunks = [];
  if (samples.length < SR * 0.3) {
    talk.length = 0;
    setTalkStatus("error", "That was too short — hold on, speak, then click Stop.");
    setPipelinePhase("idle");
    return;
  }
  const blob = encodeWav(samples, SR);
  appendUserTurn(blob, samples);
  sendTalk(blob, Math.min(seconds, samples.length / SR));
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
  setPipelinePhase("generating");
  setTalkStatus("loading", `GENERATING // ${seconds.toFixed(1)} S CLIP.`);
  const form = new FormData();
  form.append("file", blob, "question.wav");
  try {
    const response = await fetch("/api/talk", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Server error ${response.status}`);
    updatePipeline(payload);
    appendBotTurn(payload);
    setTalkStatus("", "");
  } catch (err) {
    setPipelinePhase("idle");
    setTalkStatus("error", err.message || "Something went wrong.");
  } finally {
    talk.busy = false;
    $("#talkBtn").disabled = talk.modelState !== "ready";
  }
}

/* ---------- chat bubbles ---------- */

const PLAY_ICONS =
  '<svg class="i-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13L19 12 8 5.5Z"/></svg>' +
  '<svg class="i-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

function makeAvatar(kind) {
  const avatar = document.createElement("span");
  avatar.className = `avatar avatar-${kind}`;
  avatar.setAttribute("aria-hidden", "true");
  const inner = document.createElement("span");
  inner.className = "avatar-inner";
  inner.innerHTML = kind === "bot" ? WAVE_ICON : MIC_ICON;
  avatar.append(inner);
  return avatar;
}

function stampNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

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
  bubble.append(row);

  const meta = document.createElement("div");
  meta.className = "turn-meta";
  meta.innerHTML = `<span>USER // ${fmtTime(seconds)}</span><span>${stampNow()}</span>`;
  turn.append(bubble, makeAvatar("user"), meta);
  appendTurn(turn);

  wireVoice(button, canvas, URL.createObjectURL(blob), ampsFromSamples(samples, 120), "user");
}

function appendBotTurn(payload) {
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
  bubble.append(row);

  if (payload.finishReason === "length") {
    const warn = document.createElement("p");
    warn.className = "bubble-warn";
    warn.textContent = "Reply hit the token cap — its end may be cut off.";
    bubble.append(warn);
  }

  const meta = document.createElement("div");
  meta.className = "turn-meta";
  const finish = payload.finishReason ? ` // ${String(payload.finishReason).toUpperCase()}` : "";
  meta.innerHTML =
    `<span>LFM3-AUDIO // ${fmtTime(payload.audioSec)}</span>` +
    `<span>${payload.tokens} TOKENS // ${payload.generateMs} MS${finish}</span>` +
    `<a href="${url}" download="lfm3-reply.wav">[ WAV ]</a>`;
  turn.append(makeAvatar("bot"), bubble, meta);
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
  const played = data.theme === "user" ? "#ffb35c" : "#4cdcff";
  const unplayed = data.theme === "user" ? "rgba(255, 179, 92, 0.22)" : "rgba(76, 220, 255, 0.2)";
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
  if (!decodeCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    decodeCtx = new Ctx();
  }
  const buffer = await blob.arrayBuffer();
  const decoded = await decodeCtx.decodeAudioData(buffer);
  return ampsFromSamples(decoded.getChannelData(0), buckets);
}
