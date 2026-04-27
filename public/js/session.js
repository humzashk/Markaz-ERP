/* Session timeout & activity tracker.
 * Force-logout user after server-configured inactivity window.
 * Resets on mousemove/click/keypress/scroll/touchstart.
 * Pings /api/session/keepalive on real activity (throttled) so the
 * server-side `lastActivity` never expires while the user works.
 */
(function () {
  'use strict';
  if (!window.__IS_AUTH__) return; // skip on login page

  const TIMEOUT_MS = Math.max(60_000, Number(window.__SESSION_TIMEOUT_MS__) || 15 * 60 * 1000);
  const WARN_BEFORE = Math.min(60_000, Math.floor(TIMEOUT_MS * 0.1));
  const PING_INTERVAL = Math.max(30_000, Math.floor(TIMEOUT_MS * 0.3));

  let lastActivity = Date.now();
  let lastPing = 0;
  let warnShown = false;

  function ping() {
    fetch('/api/session/keepalive', { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(r => { if (r.status === 401 || r.status === 440) doLogout(); })
      .catch(() => {});
  }
  function doLogout() { location.assign('/login?timeout=1'); }

  function onActivity() {
    lastActivity = Date.now();
    if (warnShown) hideWarning();
    if (Date.now() - lastPing > PING_INTERVAL) {
      lastPing = Date.now();
      ping();
    }
  }

  ['mousemove','mousedown','keydown','scroll','touchstart','click'].forEach(ev =>
    document.addEventListener(ev, onActivity, { passive: true })
  );

  // Warning toast
  function showWarning(secsLeft) {
    if (warnShown) { document.getElementById('sessWarnSec').textContent = secsLeft; return; }
    warnShown = true;
    const div = document.createElement('div');
    div.id = 'sessWarn';
    div.innerHTML = `<div style="position:fixed;top:14px;right:14px;z-index:9999;background:#fff;border:1px solid #f59e0b;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.08);max-width:340px;color:#1f2937;font-size:14px;">
      <strong>Session expiring in <span id="sessWarnSec">${secsLeft}</span>s</strong>
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">Move the mouse or click to stay signed in.</div>
      <button id="sessWarnStay" style="margin-top:8px;background:#1f2937;color:#fff;border:0;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;">Stay signed in</button>
    </div>`;
    document.body.appendChild(div);
    document.getElementById('sessWarnStay').addEventListener('click', () => { onActivity(); ping(); });
  }
  function hideWarning() {
    warnShown = false;
    const w = document.getElementById('sessWarn');
    if (w) w.remove();
  }

  // Timer loop
  setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (idle >= TIMEOUT_MS) return doLogout();
    if (idle >= TIMEOUT_MS - WARN_BEFORE) {
      const secsLeft = Math.max(1, Math.ceil((TIMEOUT_MS - idle) / 1000));
      showWarning(secsLeft);
    }
  }, 1000);

  // Initial ping so server lastActivity is fresh
  ping();
})();
