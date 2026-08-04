'use strict';

(() => {
  const replayButton = document.querySelector('#replayBtn');
  const status = document.querySelector('#status');
  const playState = document.querySelector('#playState');
  const playStateText = document.querySelector('#playStateText');
  const startButton = document.querySelector('#startBtn');
  const freezeButton = document.querySelector('#freezeBtn');
  if (!replayButton || !status || !playState || !playStateText) return;

  const HISTORY_MS = 5600;
  const REPLAY_MS = 5000;
  const STEP_MS = 67;
  const originalDrawFrameUrl = drawFrameUrl;
  const originalDrawDelayedFrame = drawDelayedFrame;

  let history = [];
  let replayActive = false;
  let replayTimer = null;

  function releaseHistory() {
    for (const frame of history) URL.revokeObjectURL(frame.url);
    history = [];
    replayButton.hidden = true;
    replayButton.disabled = false;
    replayButton.textContent = '↶ 直前5秒';
  }

  function trimHistory(now = performance.now()) {
    const cutoff = now - HISTORY_MS;
    while (history.length && history[0].at < cutoff) {
      URL.revokeObjectURL(history.shift().url);
    }
    const duration = history.length > 1 ? history.at(-1).at - history[0].at : 0;
    replayButton.hidden = duration < 4500 || !running;
  }

  drawFrameUrl = async function patchedDrawFrameUrl(url, mySession, myBuffer) {
    const drawn = await originalDrawFrameUrl(url, mySession, myBuffer);
    if (!drawn || replayActive || !running) return drawn;

    try {
      const response = await fetch(url);
      const blob = await response.blob();
      if (!running || replayActive || mySession !== sessionId || myBuffer !== bufferId) return drawn;
      history.push({ url: URL.createObjectURL(blob), at: performance.now() });
      trimHistory();
    } catch (error) {
      console.warn('Replay history frame skipped:', error);
    }
    return drawn;
  };

  drawDelayedFrame = async function patchedDrawDelayedFrame() {
    if (replayActive) return;
    return originalDrawDelayedFrame();
  };

  function findSnapshotFrame(snapshot, target) {
    for (let index = snapshot.length - 1; index >= 0; index -= 1) {
      if (snapshot[index].at <= target) return snapshot[index];
    }
    return snapshot[0] || null;
  }

  async function replayLastFiveSeconds() {
    if (replayActive || !running || frozen || history.length < 2) return;

    const snapshot = history.slice();
    const endAt = snapshot.at(-1).at;
    const startAt = Math.max(snapshot[0].at, endAt - REPLAY_MS);
    const mySession = sessionId;
    const myBuffer = bufferId;
    const startedAt = performance.now();

    replayActive = true;
    replayButton.disabled = true;
    replayButton.textContent = '再生中…';
    freezeButton.disabled = true;
    status.textContent = '直前5秒を再生中';
    playState.hidden = false;
    playState.classList.add('paused');
    playStateText.textContent = '直前5秒をもう一度';

    const finish = () => {
      clearInterval(replayTimer);
      replayTimer = null;
      replayActive = false;
      replayButton.disabled = false;
      replayButton.textContent = '↶ 直前5秒';
      freezeButton.disabled = false;
      if (running) {
        status.textContent = `${delaySeconds}秒前を再生中`;
        playState.classList.remove('paused');
        playStateText.textContent = `${delaySeconds}秒遅延・再生中`;
      }
      trimHistory();
    };

    const drawStep = async () => {
      if (!running || mySession !== sessionId || myBuffer !== bufferId) {
        finish();
        return;
      }
      const elapsed = performance.now() - startedAt;
      const cursor = startAt + Math.min(elapsed, endAt - startAt);
      const selected = findSnapshotFrame(snapshot, cursor);
      if (selected) {
        try { await originalDrawFrameUrl(selected.url, mySession, myBuffer); }
        catch (error) { console.warn('Replay frame skipped:', error); }
      }
      if (elapsed >= endAt - startAt) finish();
    };

    replayTimer = window.setInterval(() => { void drawStep(); }, STEP_MS);
    await drawStep();
  }

  replayButton.addEventListener('click', event => {
    event.stopPropagation();
    void replayLastFiveSeconds();
  });

  startButton.addEventListener('click', () => {
    clearInterval(replayTimer);
    replayActive = false;
    releaseHistory();
  });

  document.querySelectorAll('.delay-btn').forEach(button => {
    button.addEventListener('click', releaseHistory);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') releaseHistory();
  });

  window.addEventListener('pagehide', releaseHistory);
  replayButton.hidden = true;
})();
