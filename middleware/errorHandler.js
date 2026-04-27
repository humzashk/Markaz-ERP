'use strict';
const { logError } = require('../database');

function wrap(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function notFound(req, res) {
  if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(404).json({ error: 'Not found' });
  res.status(404).render('error', { page:'error', message:'Page not found.', back:'/' });
}

function globalErrorHandler(err, req, res, next) {
  try { logError('http.' + (req.path || ''), err, { method: req.method, body: req.body, params: req.params, query: req.query }); } catch (_) {}
  if (res.headersSent) return next(err);
  const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.status(500).json({ error: err.message || 'Server error' });
  res.status(500).render('error', { page:'error', message: 'A server error occurred. ' + (err.message || ''), back:'/' });
}

module.exports = { wrap, notFound, globalErrorHandler };
