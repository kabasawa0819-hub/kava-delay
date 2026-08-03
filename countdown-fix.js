'use strict';

(() => {
  const message = document.querySelector('#message');
  const statusEl = document.querySelector('#status');
  const delayBadge = document.querySelector('#delayBadge');
  const playState = document.querySelector('#playState');
  const playStateText = document.querySelector('#playStateText');
  const startBtn = document.querySelector('#startBtn');
  if (!message || !statusEl || !delayBadge || !playState || !playStateText || !startBtn) return;

  let finishTimer = null;

  const cancelFinish = () => {
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = null;
  };

  const finishCountdown = () => {
    if (startBtn.textContent !== '停止') return;
    const delay = delayBadge.textContent || '15';
    message.hidden = true;
    statusEl.textContent = `${delay}秒前を再生中`;
    playStateText.textContent = `${delay}秒遅延・再生中`;
    playState.hidden = false;
    playState.classList.remove('paused');
  };

  const inspectMessage = () => {
    const text = message.textContent.trim();
    if (/^1秒後に遅延映像が始まります$/.test(text)) {
      if (!finishTimer) finishTimer = setTimeout(finishCountdown, 1100);
      return;
    }
    if (/カメラ開始|エラー|容量|停止しました/.test(text)) cancelFinish();
  };

  new MutationObserver(inspectMessage).observe(message, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden']
  });

  document.querySelectorAll('.delay-btn').forEach(button => {
    button.addEventListener('click', cancelFinish);
  });
  startBtn.addEventListener('click', cancelFinish);
  inspectMessage();
})();
