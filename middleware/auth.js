// RBAC middleware for Markaz ERP
const _database = require('../database');
// Use getter so we always pick up initialized db (middleware is required before initDatabase())
Object.defineProperty(module, 'db', { get: () => _database.db });
const getDb = () => _database.db;

// All available modules (keep in sync with sidebar + routes)
const ALL_MODULES = [
  'dashboard', 'customers', 'vendors',
  'products', 'ratelist', 'warehouses', 'stock',
  'orders', 'invoices', 'purchases', 'creditnotes', 'bilty', 'breakage', 'expenses',
  'payments-receive', 'payments-pay', 'bank',
  'daybook', 'journal', 'ledger', 'reports',
  'categories', 'importexport', 'settings',
  'users'
];

// Map URL path → module key (for middleware auto-detection)
const PATH_MODULE_MAP = {
  '/': 'dashboard',
  '/customers': 'customers',
  '/vendors': 'vendors',
  '/products': 'products',
  '/ratelist': 'ratelist',
  '/warehouses': 'warehouses',
  '/stock': 'stock',
  '/orders': 'orders',
  '/invoices': 'invoices',
  '/purchases': 'purchases',
  '/creditnotes': 'creditnotes',
  '/bilty': 'bilty',
  '/breakage': 'breakage',
  '/expenses': 'expenses',
  '/payments/receive': 'payments-receive',
  '/payments/pay': 'payments-pay',
  '/bank': 'bank',
  '/daybook': 'daybook',
  '/journal': 'journal',
  '/ledger': 'ledger',
  '/reports': 'reports',
  '/categories': 'categories',
  '/importexport': 'importexport',
  '/settings': 'settings',
  '/users': 'users'
};

function loadUser(req, res, next) {
  res.locals.currentUser = null;
  res.locals.userModules = [];
  res.locals.ALL_MODULES = ALL_MODULES;
  try {
    const db = getDb();
    if (db && req.session && req.session.userId) {
      const u = db.prepare(
        'SELECT id, username, name, email, role, status FROM users WHERE id = ?'
      ).get(req.session.userId);
      if (u && u.status === 'active') {
        let modules;
        if (u.role === 'superadmin' || u.role === 'admin') {
          modules = ALL_MODULES.slice();
        } else {
          const rows = db.prepare('SELECT module FROM user_permissions WHERE user_id = ?').all(u.id);
          modules = rows.map(r => r.module);
        }
        req.user = u;
        req.userModules = modules;
        res.locals.currentUser = u;
        res.locals.userModules = modules;
      } else {
        req.session.destroy(() => {});
      }
    }
  } catch(e) { console.warn('loadUser error:', e.message); }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.xhr || (req.headers.accept || '').includes('application/json')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }
  next();
}

function requireModule(mod) {
  return function(req, res, next) {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'superadmin' || req.user.role === 'admin') return next();
    if ((req.userModules || []).includes(mod)) return next();
    return res.status(403).render('error', {
      page: 'error',
      message: 'Access denied. You do not have permission to view this module.',
      back: '/'
    });
  };
}

function requireRole(...roles) {
  return function(req, res, next) {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', {
        page: 'error',
        message: 'Access denied. Insufficient role.',
        back: '/'
      });
    }
    next();
  };
}

// Determine top-level module for arbitrary request path
function moduleForPath(url) {
  if (!url) return null;
  const clean = url.split('?')[0];
  if (clean === '/' || clean === '') return 'dashboard';
  if (clean.startsWith('/payments/receive')) return 'payments-receive';
  if (clean.startsWith('/payments/pay')) return 'payments-pay';
  const parts = clean.split('/').filter(Boolean);
  const first = '/' + parts[0];
  return PATH_MODULE_MAP[first] || null;
}

// Auto-guard: applied globally after login routes — blocks any unauth'd access
function autoGuard(req, res, next) {
  // public paths
  const openPaths = ['/login', '/logout', '/favicon.ico'];
  if (openPaths.includes(req.path)) return next();
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/') ||
      req.path.startsWith('/uploads/') || req.path.startsWith('/images/') ||
      req.path.endsWith('.png') || req.path.endsWith('.jpg') ||
      req.path.endsWith('.ico') || req.path.endsWith('.css') ||
      req.path.endsWith('.js')) return next();

  if (!req.user) return res.redirect('/login');

  // superadmin & admin bypass all module checks
  if (req.user.role === 'superadmin' || req.user.role === 'admin') return next();

  const mod = moduleForPath(req.path);
  if (!mod) return next(); // unknown path — let route handle
  if ((req.userModules || []).includes(mod)) return next();

  return res.status(403).render('error', {
    page: 'error',
    message: 'Access denied. You do not have permission for this page.',
    back: '/'
  });
}

module.exports = {
  ALL_MODULES,
  loadUser,
  requireAuth,
  requireModule,
  requireRole,
  autoGuard,
  moduleForPath
};
