'use strict';

const live = document.querySelector('#live');
const canvas = document.querySelector('#delayed');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { alpha: false });
const startBtn = document.querySelector('#startBtn');
const switchBtn = document.querySelector('#switchBtn');
const mirrorBtn = document.querySelector('#mirrorBtn');
const freezeBtn = document.querySelector('#freezeBtn');
const fullBtn = document.querySelector('#fullBtn');
const message = document.querySelector('#message');
const statusEl = document.querySelector('#status');
const delayBadge = document.querySelector('#delayBadge');
const viewer = document.querySelector('#viewer');
const playState = document.querySelector('#playState');
const playStateText = document.querySelector('#playStateText');
const brightnessRange = document.querySelector('#brightnessRange');
const brightnessValue = document.querySelector('#brightnessValue');
const delayButtons = [...document.querySelectorAll('.delay-btn')];

let delaySeconds = 15;
let facingMode = 'environment';
let stream = null;
let running = false;
let frozen = false;
let mirrored = false;
let monitorMode = false;
let frames = [];
let totalBytes = 0;
let captureTimer = null;
let playbackTimer = null;
let countdownTimer = null;
let sessionId = 0;
let bufferId = 0;
let captureBusyKey = null;
let drawBusyKey = null;
let wakeLock = null;
let firstCaptureAt = 0;
let operationBusy = false;
let trackEndedHandler = null;

const FPS = 15;
const FRAME_INTERVAL = Math.round(1000 / FPS);
const MAX_EXTRA_SECONDS = 2;
const MAX_WIDTH = 640;
const JPEG_QUALITY = 0.46;
const MAX_BUFFER_BYTES = 48 * 1024 * 1024;

function setControlsBusy(busy) {
  operationBusy = busy;
  startBtn.disabled = busy;
  switchBtn.disabled = busy;
  delayButtons.forEach(button => { button.disabled = busy; });
}

function setPlaybackState(text = '', visible = false, paused = false) {
  playStateText.textContent = text;
  playState.hidden = !visible;
  playState.classList.toggle('paused', paused);
}

function applyBrightness(value) {
  const safeValue = Math.min(180, Math.max(80, Number(value) || 120));
  brightnessRange.value = String(safeValue);
  brightnessValue.value = `${safeValue}%`;
  document.documentElement.style.setProperty('--video-brightness', String(safeValue / 100));
  try { localStorage.setItem('kava-delay-brightness', String(safeValue)); } catch (_) {}
}

function clearCanvas() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function revokeFrame(frame) {
  if (!frame) return;
  if (frame.url) URL.revokeObjectURL(frame.url);
  totalBytes = Math.max(0, totalBytes - (frame.bytes || 0));
}

function releaseFrames() {
  for (const frame of frames) revokeFrame(frame);
  frames = [];
  totalBytes = 0;
}

function resetBuffer() {
  bufferId += 1;
  firstCaptureAt = 0;
  releaseFrames();
  clearCanvas();
}

function trimBuffer(now = performance.now()) {
  const cutoff = now - (delaySeconds + MAX_EXTRA_SECONDS) * 1000;
  while (frames.length && frames[0].at < cutoff) revokeFrame(frames.shift());
}

function waitForVideoMetadata(video, timeoutMs = 4000) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('カメラ映像の準備に時間がかかっています。もう一度開始してください。'));
    }, timeoutMs);
    const onReady = () => { cleanup(); resolve(); };
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('resize', onReady);
    };
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('resize', onReady, { once: true });
  });
}

function fitCanvasToVideo() {
  const sourceWidth = live.videoWidth || 1280;
  const sourceHeight = live.videoHeight || 720;
  const scale = Math.min(1, MAX_WIDTH / sourceWidth);
  const width = Math.max(240, Math.round(sourceWidth * scale));
  const height = Math.max(180, Math.round(sourceHeight * scale));
  canvas.width = captureCanvas.width = width;
  canvas.height = captureCanvas.height = height;
  viewer.style.aspectRatio = `${width} / ${height}`;
  clearCanvas();
}

function canvasToBlob(canvasEl) {
  return new Promise((resolve, reject) => {
    canvasEl.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('映像の一時変換に失敗しました。')),
      'image/jpeg',
      JPEG_QUALITY
    );
  });
}

async function captureFrame() {
  const mySession = sessionId;
  const myBuffer = bufferId;
  const busyKey = `${mySession}:${myBuffer}`;
  if (!running || live.readyState < 2 || captureBusyKey === busyKey) return;
  if (totalBytes >= MAX_BUFFER_BYTES) return;

  captureBusyKey = busyKey;
  const capturedAt = performance.now();
  try {
    captureCtx.setTransform(1, 0, 0, 1, 0, 0);
    captureCtx.drawImage(live, 0, 0, captureCanvas.width, captureCanvas.height);
    const blob = await canvasToBlob(captureCanvas);

    if (!running || mySession !== sessionId || myBuffer !== bufferId) return;
    if (totalBytes + blob.size > MAX_BUFFER_BYTES) return;

    const url = URL.createObjectURL(blob);
    frames.push({ url, at: capturedAt, bytes: blob.size, session: mySession, buffer: myBuffer });
    totalBytes += blob.size;
    if (!firstCaptureAt) firstCaptureAt = capturedAt;
    trimBuffer();
  } catch (error) {
    console.warn('Frame capture skipped:', error);
  } finally {
    if (captureBusyKey === busyKey) captureBusyKey = null;
  }
}

async function drawFrameUrl(url, mySession, myBuffer) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  if (!running || mySession !== sessionId || myBuffer !== bufferId) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (mirrored) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

async function drawDelayedFrame() {
  const mySession = sessionId;
  const myBuffer = bufferId;
  const busyKey = `${mySession}:${myBuffer}`;
  if (!running || frozen || !frames.length || drawBusyKey === busyKey) return;

  const target = performance.now() - delaySeconds * 1000;
  let selected = null;
  while (frames.length && frames[0].at <= target) {
    const ready = frames.shift();
    if (selected) revokeFrame(selected);
    selected = ready;
  }
  if (!selected) return;

  drawBusyKey = busyKey;
  try {
    await drawFrameUrl(selected.url, mySession, myBuffer);
  } catch (error) {
    console.warn('Frame draw skipped:', error);
  } finally {
    revokeFrame(selected);
    if (drawBusyKey === busyKey) drawBusyKey = null;
  }
}

function startLoops() {
  stopLoops();
  captureTimer = window.setInterval(captureFrame, FRAME_INTERVAL);
  playbackTimer = window.setInterval(drawDelayedFrame, FRAME_INTERVAL);
}

function stopLoops() {
  clearInterval(captureTimer);
  clearInterval(playbackTimer);
  clearInterval(countdownTimer);
  captureTimer = playbackTimer = countdownTimer = null;
}

function startCountdown() {
  firstCaptureAt = 0;
  message.hidden = false;
  setPlaybackState('', false);
  clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    if (!running) return;
    if (!firstCaptureAt) {
      message.textContent = totalBytes >= MAX_BUFFER_BYTES
        ? '端末の一時容量が不足しています。遅延時間を短くしてください。'
        : 'カメラ映像を準備しています';
      return;
    }
    const elapsed = (performance.now() - firstCaptureAt) / 1000;
    const left = Math.max(0, Math.ceil(delaySeconds - elapsed));
    if (left > 0) {
      message.textContent = `${left}秒後に遅延映像が始まります`;
      statusEl.textContent = `${delaySeconds}秒遅延・準備中`;
    } else if (frames.some(frame => frame.at <= performance.now() - delaySeconds * 1000)) {
      message.hidden = true;
      statusEl.textContent = `${delaySeconds}秒前を再生中`;
      setPlaybackState(`${delaySeconds}秒遅延・再生中`, true);
      clearInterval(countdownTimer);
      countdownTimer = null;
    } else if (totalBytes >= MAX_BUFFER_BYTES) {
      message.hidden = false;
      message.textContent = 'この端末では容量が足りません。遅延時間を短くしてください。';
      statusEl.textContent = '端末容量不足';
      setPlaybackState('', false);
    }
  }, 200);
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || !running || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (error) {
    console.warn('Wake Lock unavailable:', error);
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch (_) {}
  wakeLock = null;
}

function attachTrackEndedHandler(activeStream, mySession) {
  const track = activeStream.getVideoTracks()[0];
  if (!track) return;
  trackEndedHandler = async () => {
    if (mySession !== sessionId || !running) return;
    await stopCamera();
    message.hidden = false;
    message.textContent = 'カメラが停止しました。「カメラ開始」を押して再開してください。';
    statusEl.textContent = 'カメラ停止';
  };
  track.addEventListener('ended', trackEndedHandler, { once: true });
}

async function startCamera() {
  await stopCamera();
  const mySession = ++sessionId;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザはカメラに対応していません。SafariまたはChromeを最新版にしてください。');
  }

  const newStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: false
  });

  if (mySession !== sessionId) {
    newStream.getTracks().forEach(track => track.stop());
    return;
  }

  stream = newStream;
  live.srcObject = stream;
  await live.play();
  await waitForVideoMetadata(live);
  if (mySession !== sessionId) {
    newStream.getTracks().forEach(track => track.stop());
    return;
  }

  fitCanvasToVideo();
  resetBuffer();
  running = true;
  frozen = false;
  freezeBtn.textContent = '一時停止';
  startBtn.textContent = '停止';
  startBtn.classList.add('running');
  attachTrackEndedHandler(stream, mySession);
  startCountdown();
  startLoops();
  await captureFrame();
  await requestWakeLock();
}

async function stopCamera() {
  ++sessionId;
  running = false;
  frozen = false;
  stopLoops();
  await releaseWakeLock();

  if (stream) {
    const track = stream.getVideoTracks()[0];
    if (track && trackEndedHandler) track.removeEventListener('ended', trackEndedHandler);
    stream.getTracks().forEach(item => item.stop());
  }
  trackEndedHandler = null;
  stream = null;
  live.srcObject = null;
  resetBuffer();

  startBtn.textContent = 'カメラ開始';
  startBtn.classList.remove('running');
  freezeBtn.textContent = '一時停止';
  statusEl.textContent = '停止中';
  message.hidden = false;
  message.textContent = '「カメラ開始」を押してください';
  setPlaybackState('', false);
}

function showError(error) {
  console.error(error);
  message.hidden = false;
  setPlaybackState('', false);
  if (error?.name === 'NotAllowedError') {
    message.textContent = 'カメラが許可されていません。ブラウザの設定でカメラを許可してください。';
  } else if (error?.name === 'NotFoundError') {
    message.textContent = '使用できるカメラが見つかりません。';
  } else if (error?.name === 'NotReadableError') {
    message.textContent = 'ほかのアプリがカメラを使用中です。カメラアプリなどを閉じてください。';
  } else {
    message.textContent = error?.message || 'エラーが発生しました。';
  }
  statusEl.textContent = 'エラー';
}

startBtn.addEventListener('click', async () => {
  if (operationBusy) return;
  setControlsBusy(true);
  try {
    running ? await stopCamera() : await startCamera();
  } catch (error) {
    await stopCamera();
    showError(error);
  } finally {
    setControlsBusy(false);
  }
});

switchBtn.addEventListener('click', async () => {
  if (operationBusy) return;
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  if (!running) return;
  setControlsBusy(true);
  try {
    await startCamera();
  } catch (error) {
    await stopCamera();
    showError(error);
  } finally {
    setControlsBusy(false);
  }
});

mirrorBtn.addEventListener('click', () => {
  mirrored = !mirrored;
  mirrorBtn.textContent = `左右反転：${mirrored ? 'ON' : 'OFF'}`;
});

freezeBtn.addEventListener('click', () => {
  if (!running || operationBusy) return;
  frozen = !frozen;
  freezeBtn.textContent = frozen ? '再開' : '一時停止';
  statusEl.textContent = frozen ? '映像を一時停止中' : `${delaySeconds}秒前を再生中`;
  setPlaybackState(
    frozen ? `${delaySeconds}秒遅延・一時停止` : `${delaySeconds}秒遅延・再生中`,
    true,
    frozen
  );
});

function setMonitorMode(enabled) {
  monitorMode = enabled;
  document.body.classList.toggle('monitor-mode', enabled);
  fullBtn.textContent = enabled ? '通常画面へ戻る' : 'モニター全画面';
}

viewer.addEventListener('click', async event => {
  if (!monitorMode) return;
  if (event.target.closest('.play-state')) return;
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  setMonitorMode(false);
});

fullBtn.addEventListener('click', async () => {
  if (monitorMode) {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    setMonitorMode(false);
    return;
  }
  setMonitorMode(true);
  try {
    if (viewer.requestFullscreen) await viewer.requestFullscreen();
    else if (viewer.webkitRequestFullscreen) viewer.webkitRequestFullscreen();
  } catch (_) {}
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && monitorMode) setMonitorMode(false);
});

delayButtons.forEach(btn => btn.addEventListener('click', async () => {
  if (operationBusy) return;
  delaySeconds = Number(btn.dataset.delay);
  delayBadge.textContent = String(delaySeconds);
  delayButtons.forEach(button => button.classList.toggle('active', button === btn));
  if (!running) return;

  resetBuffer();
  startCountdown();
  await captureFrame();
}));

brightnessRange.addEventListener('input', event => {
  applyBrightness(event.target.value);
});

document.addEventListener('visibilitychange', async () => {
  if (!running) return;
  if (document.visibilityState === 'visible') {
    resetBuffer();
    startCountdown();
    await captureFrame();
    await requestWakeLock();
  } else {
    await releaseWakeLock();
  }
});

window.addEventListener('pagehide', () => { void stopCamera(); });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && monitorMode) setMonitorMode(false);
});

let savedBrightness = 120;
try { savedBrightness = Number(localStorage.getItem('kava-delay-brightness')) || 120; } catch (_) {}
applyBrightness(savedBrightness);
clearCanvas();
setPlaybackState('', false);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
