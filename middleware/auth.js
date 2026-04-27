'use strict';
const { pool } = require('../database');

const ALL_MODULES = [
  'dashboard', 'customers', 'vendors',
  'products', 'ratelist', 'warehouses', 'stock',
  'orders', 'invoices', 'purchases', 'creditnotes', 'bilty', 'transports', 'breakage', 'expenses',
  'payments-receive', 'payments-pay',
  'daybook', 'journal', 'ledger', 'reports',
  'categories', 'importexport', 'settings', 'users'
];

const PATH_MODULE_MAP = {
  '/': 'dashboard',
  '/customers':'customers','/vendors':'vendors','/products':'products','/ratelist':'ratelist',
  '/warehouses':'warehouses','/stock':'stock',
  '/orders':'orders','/invoices':'invoices','/purchases':'purchases',
  '/creditnotes':'creditnotes','/bilty':'bilty','/transports':'transports',
  '/breakage':'breakage','/expenses':'expenses',
  '/payments/receive':'payments-receive','/payments/pay':'payments-pay',
  '/daybook':'daybook','/journal':'journal','/ledger':'ledger','/reports':'reports',
  '/categories':'categories','/importexport':'importexport','/settings':'settings','/users':'users'
};

async function loadUser(req, res, next) {
  res.locals.currentUser = null;
  res.locals.userModules = [];
  res.locals.ALL_MODULES = ALL_MODULES;
  try {
    if (req.session && req.session.userId) {
      const r = await pool.query(`SELECT id, username, name, email, role, status FROM users WHERE id=$1`, [req.session.userId]);
      const u = r.rows[0];
      if (u && u.status === 'active') {
        let modules;
        if (u.role === 'superadmin' || u.role === 'admin') modules = ALL_MODULES.slice();
        else {
          const p = await pool.query(`SELECT module FROM user_permissions WHERE user_id=$1`, [u.id]);
          modules = p.rows.map(r => r.module);
        }
        req.user = u; req.userModules = modules;
        res.locals.currentUser = u; res.locals.userModules = modules;
      } else {
        req.session.destroy(()=>{});
      }
    }
  } catch (e) { console.warn('loadUser:', e.message); }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return function(req, res, next) {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return res.status(403).render('error', { page:'error', message:'Access denied. Insufficient role.', back:'/' });
    next();
  };
}

function moduleForPath(url) {
  if (!url) return null;
  const clean = url.split('?')[0];
  if (clean === '/' || clean === '') return 'dashboard';
  if (clean.startsWith('/payments/receive')) return 'payments-receive';
  if (clean.startsWith('/payments/pay')) return 'payments-pay';
  const parts = clean.split('/').filter(Boolean);
  return PATH_MODULE_MAP['/' + parts[0]] || null;
}

function autoGuard(req, res, next) {
  const open = ['/login','/logout','/favicon.ico'];
  if (open.includes(req.path)) return next();
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/') ||
      req.path.startsWith('/uploads/') || req.path.startsWith('/images/') ||
      /\.(png|jpe?g|gif|webp|svg|ico|css|js|map)$/i.test(req.path)) return next();
  if (!req.user) return res.redirect('/login');
  if (req.user.role === 'superadmin' || req.user.role === 'admin') return next();
  const mod = moduleForPath(req.path);
  if (!mod) return next();
  if ((req.userModules || []).includes(mod)) return next();
  return res.status(403).render('error', { page:'error', message:'Access denied. You do not have permission for this page.', back:'/' });
}

module.exports = { ALL_MODULES, loadUser, requireAuth, requireRole, autoGuard, moduleForPath };
