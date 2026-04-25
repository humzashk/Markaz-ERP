// middleware/errorHandler.js — central error wrapper + global handler.
'use strict';
const path = require('path');

let _logError = (..._a) => {};
try { _logError = require(path.join('..','database')).logError || _logError; } catch (_) {}

// Wrap an async/sync handler so any thrown error is caught and forwarded.
function wrap(fn) {
  return function (req, res, next) {
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.then === 'function') ret.catch(next);
    } catch (e) { next(e); }
  };
}

// Global error handler — last middleware in the chain.
function globalErrorHandler(err, req, res, _next) {
  const scope = (req && req.path) || 'app';
  try { _logError('http.' + scope, err, { method: req && req.method, query: req && req.query }); } catch (_) {}
  if (res.headersSent) return;
  const wantsJson = ((req.headers && req.headers.accept) || '').includes('application/json') || req.xhr;
  const code = err && err.status ? err.status : 500;
  const message = (err && err.message) || 'Server error';
  if (wantsJson) {
    return res.status(code).json({ success: false, error: message });
  }
  // For non-JSON: redirect to referer with err= or render simple message
  const back = (req.get && req.get('Referer')) || '/';
  if (back && back !== req.originalUrl) {
    const sep = back.includes('?') ? '&' : '?';
    return res.redirect(back + sep + 'err=' + encodeURIComponent(message).slice(0, 800));
  }
  res.status(code).send('<pre>' + (message || '').replace(/[<>]/g,'') + '</pre>');
}

// 404 handler
function notFound(req, res) {
  if ((req.headers.accept || '').includes('application/json')) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.status(404).send('<h2>404 — Not found</h2><a href="/">Home</a>');
}

module.exports = { wrap, globalErrorHandler, notFound };
