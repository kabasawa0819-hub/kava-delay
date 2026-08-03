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

let delaySeconds = 15;
let facingMode = 'environment';
let stream = null;
let running = false;
let frozen = false;
let mirrored = false;
let monitorMode = false;
let frames = [];
let captureTimer = null;
let playbackTimer = null;
let countdownTimer = null;
let captureInFlight = false;
let drawInFlight = false;
let sessionId = 0;

// 素早いスポーツ動作を確認できるよう15fpsで循環保持する。
// 端末の処理が追いつかない場合はcaptureInFlightにより自動で間引かれる。
const FPS = 15;
const FRAME_INTERVAL = Math.round(1000 / FPS);
const MAX_EXTRA_SECONDS = 2;
const MAX_WIDTH = 720;
const JPEG_QUALITY = 0.52;

function clearCanvas() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function releaseFrames() {
  for (const frame of frames) {
    if (frame.url) URL.revokeObjectURL(frame.url);
  }
  frames = [];
}

function fitCanvasToVideo() {
  const sourceWidth = live.videoWidth || 1280;
  const sourceHeight = live.videoHeight || 720;
  const scale = Math.min(1, MAX_WIDTH / sourceWidth);
  const width = Math.max(320, Math.round(sourceWidth * scale));
  const height = Math.max(180, Math.round(sourceHeight * scale));
  canvas.width = captureCanvas.width = width;
  canvas.height = captureCanvas.height = height;
  clearCanvas();
}

function canvasToBlob(canvasEl) {
  return new Promise((resolve, reject) => {
    canvasEl.toBlob(blob => blob ? resolve(blob) : reject(new Error('映像の一時変換に失敗しました。')), 'image/jpeg', JPEG_QUALITY);
  });
}

async function captureFrame() {
  if (!running || live.readyState < 2 || captureInFlight) return;
  const mySession = sessionId;
  captureInFlight = true;
  try {
    captureCtx.save();
    captureCtx.setTransform(1, 0, 0, 1, 0, 0);
    captureCtx.drawImage(live, 0, 0, captureCanvas.width, captureCanvas.height);
    captureCtx.restore();
    const blob = await canvasToBlob(captureCanvas);
    if (!running || mySession !== sessionId) return;
    const url = URL.createObjectURL(blob);
    frames.push({ url, at: performance.now(), session: mySession });

    const cutoff = performance.now() - (delaySeconds + MAX_EXTRA_SECONDS) * 1000;
    while (frames.length && frames[0].at < cutoff) {
      const old = frames.shift();
      URL.revokeObjectURL(old.url);
    }
  } catch (error) {
    console.warn('Frame capture skipped:', error);
  } finally {
    captureInFlight = false;
  }
}

async function drawFrameUrl(url) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
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
  if (!running || frozen || !frames.length || drawInFlight) return;
  const mySession = sessionId;
  const target = performance.now() - delaySeconds * 1000;
  let selected = null;
  while (frames.length && frames[0].at <= target) {
    const ready = frames.shift();
    if (selected) URL.revokeObjectURL(selected.url);
    selected = ready;
  }
  if (!selected) return;

  drawInFlight = true;
  try {
    await drawFrameUrl(selected.url);
    if (!running || mySession !== sessionId) return;
  } catch (error) {
    console.warn('Frame draw skipped:', error);
  } finally {
    URL.revokeObjectURL(selected.url);
    drawInFlight = false;
  }
}

function startLoops() {
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
  const startedAt = performance.now();
  message.hidden = false;
  countdownTimer = window.setInterval(() => {
    if (!running) return;
    const elapsed = (performance.now() - startedAt) / 1000;
    const left = Math.max(0, Math.ceil(delaySeconds - elapsed));
    if (left > 0) {
      message.textContent = `${left}秒後に遅延映像が始まります`;
      statusEl.textContent = `${delaySeconds}秒遅延・準備中`;
    } else {
      message.hidden = true;
      statusEl.textContent = `${delaySeconds}秒前を滑らか再生中`;
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 200);
}

async function startCamera() {
  await stopCamera();
  sessionId += 1;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('このブラウザはカメラに対応していません。SafariまたはChromeを最新版にしてください。');
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: false
  });
  live.srcObject = stream;
  await live.play();
  fitCanvasToVideo();
  running = true;
  frozen = false;
  freezeBtn.textContent = '一時停止';
  startBtn.textContent = '停止';
  startBtn.classList.add('running');
  startLoops();
  await captureFrame();
  startCountdown();
}

async function stopCamera() {
  sessionId += 1;
  running = false;
  captureInFlight = false;
  drawInFlight = false;
  stopLoops();
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  live.srcObject = null;
  releaseFrames();
  clearCanvas();
  startBtn.textContent = 'カメラ開始';
  startBtn.classList.remove('running');
  statusEl.textContent = '停止中';
  message.hidden = false;
  message.textContent = '「カメラ開始」を押してください';
}

function showError(error) {
  console.error(error);
  message.hidden = false;
  if (error?.name === 'NotAllowedError') {
    message.textContent = 'カメラが許可されていません。ブラウザの設定でカメラを許可してください。';
  } else if (error?.name === 'NotFoundError') {
    message.textContent = '使用できるカメラが見つかりません。';
  } else {
    message.textContent = error?.message || 'エラーが発生しました。';
  }
  statusEl.textContent = 'エラー';
}

startBtn.addEventListener('click', async () => {
  try { running ? await stopCamera() : await startCamera(); }
  catch (error) { await stopCamera(); showError(error); }
});

switchBtn.addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  if (!running) return;
  try { await startCamera(); }
  catch (error) { await stopCamera(); showError(error); }
});

mirrorBtn.addEventListener('click', () => {
  mirrored = !mirrored;
  mirrorBtn.textContent = `左右反転：${mirrored ? 'ON' : 'OFF'}`;
});

freezeBtn.addEventListener('click', () => {
  if (!running) return;
  frozen = !frozen;
  freezeBtn.textContent = frozen ? '再開' : '一時停止';
  statusEl.textContent = frozen ? '映像を一時停止中' : `${delaySeconds}秒前を滑らか再生中`;
});

function setMonitorMode(enabled) {
  monitorMode = enabled;
  document.body.classList.toggle('monitor-mode', enabled);
  fullBtn.textContent = enabled ? '通常画面へ戻る' : 'モニター全画面';
}

viewer.addEventListener('click', async () => {
  if (!monitorMode) return;
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
  } catch (_) {
    // CSSモニターモードは維持する。
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && monitorMode) setMonitorMode(false);
});

document.querySelectorAll('.delay-btn').forEach(btn => btn.addEventListener('click', async () => {
  delaySeconds = Number(btn.dataset.delay);
  delayBadge.textContent = String(delaySeconds);
  document.querySelectorAll('.delay-btn').forEach(b => b.classList.toggle('active', b === btn));
  if (!running) return;
  releaseFrames();
  clearCanvas();
  clearInterval(countdownTimer);
  await captureFrame();
  startCountdown();
}));

window.addEventListener('pagehide', stopCamera);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && monitorMode) setMonitorMode(false);
});

clearCanvas();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
