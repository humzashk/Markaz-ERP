/* SPA-like navigation: intercept internal links and form submits, fetch the new
 * page in the background, swap only the .content-wrapper, preserve scroll for
 * filter forms, and skip full page reloads. Falls back gracefully on errors.
 */
(function () {
  'use strict';
  if (window.SPA) return;

  const CONTAINER_SEL = '.content-wrapper';
  const SKIP_DATA_ATTR = 'data-no-spa';
  const inflight = { ctrl: null };

  function isInternal(href) {
    if (!href) return false;
    if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
    if (href.startsWith('#')) return false;
    if (/^https?:\/\//i.test(href)) {
      try { return new URL(href).origin === location.origin; } catch (_) { return false; }
    }
    return true;
  }

  // Skip endpoints that return non-HTML or must trigger native browser handling.
  function shouldSkip(url) {
    const lower = String(url).toLowerCase();
    return lower.includes('/print/') || lower.includes('/pdf/') ||
           lower.includes('/api/') || lower.includes('/uploads/') ||
           lower.endsWith('.pdf') || lower.endsWith('.csv') ||
           lower.endsWith('.xlsx') || lower.endsWith('.xls') ||
           lower.endsWith('.png') || lower.endsWith('.jpg') ||
           lower.includes('/login') || lower.includes('/logout');
  }

  function parseAndSwap(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const incoming = doc.querySelector(CONTAINER_SEL);
    const current = document.querySelector(CONTAINER_SEL);
    if (!incoming || !current) return false;

    // Update document title
    if (doc.title) document.title = doc.title;

    // Update sidebar active state if shipped in the new page
    const newSidebar = doc.querySelector('#sidebar');
    const curSidebar = document.querySelector('#sidebar');
    if (newSidebar && curSidebar) curSidebar.innerHTML = newSidebar.innerHTML;

    // Swap content
    current.innerHTML = incoming.innerHTML;

    // Execute any inline scripts in the new content (DOMParser doesn't run them)
    Array.from(current.querySelectorAll('script')).forEach(s => {
      const ns = document.createElement('script');
      if (s.src) ns.src = s.src; else ns.textContent = s.textContent;
      Array.from(s.attributes).forEach(a => { if (a.name !== 'src') ns.setAttribute(a.name, a.value); });
      s.replaceWith(ns);
    });

    document.dispatchEvent(new CustomEvent('spa:loaded', { detail: { url: location.href } }));
    return true;
  }

  async function navigate(url, opts) {
    opts = opts || {};
    if (!url || shouldSkip(url)) { location.assign(url); return; }
    // Cancel any in-flight nav
    if (inflight.ctrl) inflight.ctrl.abort();
    inflight.ctrl = new AbortController();
    try {
      const savedScroll = opts.preserveScroll ? window.scrollY : 0;
      document.body.classList.add('spa-loading');
      const res = await fetch(url, { headers: { 'X-Partial': '1' }, credentials: 'same-origin', signal: inflight.ctrl.signal });
      if (res.status === 401 || res.status === 440) { location.assign('/login?timeout=1'); return; }
      if (res.redirected) { history.replaceState({}, '', res.url); }
      const html = await res.text();
      const ok = parseAndSwap(html);
      if (!ok) { location.assign(url); return; }
      if (!opts.replace) history.pushState({ spa: true }, '', url);
      if (opts.preserveScroll) window.scrollTo({ top: savedScroll });
      else window.scrollTo({ top: 0 });
    } catch (e) {
      if (e.name !== 'AbortError') location.assign(url);
    } finally {
      document.body.classList.remove('spa-loading');
    }
  }

  // ===== Click interception on internal links =====
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a');
    if (!a) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute(SKIP_DATA_ATTR)) return;
    if (a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!isInternal(href)) return;
    if (shouldSkip(href)) return;
    e.preventDefault();
    navigate(href, { preserveScroll: false });
  });

  // ===== Form interception (GET filters use SPA + scroll preserve) =====
  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (!form || form.hasAttribute(SKIP_DATA_ATTR)) return;
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return; // POSTs (data writes) keep native submit for safety
    const action = form.getAttribute('action') || location.pathname;
    if (!isInternal(action) || shouldSkip(action)) return;
    e.preventDefault();
    const fd = new FormData(form);
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (v !== '') params.append(k, v);
    const url = action.split('?')[0] + (params.toString() ? '?' + params.toString() : '');
    navigate(url, { preserveScroll: true });
  });

  // ===== History (back/forward) =====
  window.addEventListener('popstate', function () {
    navigate(location.pathname + location.search, { replace: true, preserveScroll: false });
  });

  // Loading bar style
  const css = document.createElement('style');
  css.textContent = `
    body.spa-loading { cursor: progress; }
    body.spa-loading::before { content:''; position:fixed; top:0; left:0; height:2px; width:100%;
      background:linear-gradient(90deg,#1f2937 0%,#1f2937 var(--p,30%),transparent var(--p,30%));
      animation: spaBar 1s linear infinite; z-index:9999; }
    @keyframes spaBar { 0%{--p:10%} 50%{--p:60%} 100%{--p:95%} }
  `;
  document.head.appendChild(css);

  window.SPA = { navigate };
})();
