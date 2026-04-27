'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { pool, getSettings } = require('../database');
const { wrap } = require('../middleware/errorHandler');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const scope = (req.params.scope || req.body.scope || 'plastic_markaz').replace(/[^a-z_]/g,'');
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `logo_${scope}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(png|jpe?g|gif|webp|svg\+xml)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

async function setSetting(key, value) {
  await pool.query(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

router.get('/', wrap(async (req, res) => {
  const settings = await getSettings();
  res.render('settings/index', { page:'settings', settings, saved: req.query.saved });
}));

router.post('/logo/:scope', upload.single('logo'), wrap(async (req, res) => {
  const scope = req.params.scope;
  if (!['plastic_markaz','wings_furniture','cooler','default'].includes(scope)) return res.redirect('/settings?err=bad_scope');
  if (!req.file) return res.redirect('/settings?err=no_file');
  await setSetting('logo_' + scope, '/uploads/' + req.file.filename);
  res.redirect('/settings?saved=1#logos');
}));

router.post('/logo/:scope/remove', wrap(async (req, res) => {
  const scope = req.params.scope;
  const r = await pool.query(`SELECT value FROM settings WHERE key=$1`, ['logo_' + scope]);
  if (r.rows[0] && r.rows[0].value) {
    const file = path.join(__dirname, '..', 'public', r.rows[0].value);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch(_){}
  }
  await pool.query(`DELETE FROM settings WHERE key=$1`, ['logo_' + scope]);
  res.redirect('/settings#logos');
}));

router.post('/logo/:scope/meta', express.json(), wrap(async (req, res) => {
  const scope = req.params.scope;
  if (!['plastic_markaz','wings_furniture','cooler','default'].includes(scope)) return res.status(400).json({ ok:false, error:'bad_scope' });
  const b = req.body || {};
  const meta = {
    w: Math.max(40, Math.min(600, parseInt(b.w,10) || 240)),
    h: Math.max(20, Math.min(300, parseInt(b.h,10) || 90)),
    align: ['left','center','right'].includes(b.align) ? b.align : 'center',
    offsetX: Math.max(-200, Math.min(200, parseInt(b.offsetX,10) || 0)),
    offsetY: Math.max(-100, Math.min(100, parseInt(b.offsetY,10) || 0))
  };
  await setSetting('logo_meta_' + scope, JSON.stringify(meta));
  res.json({ ok:true, meta });
}));

router.post('/', wrap(async (req, res) => {
  const fields = [
    'business_name','business_tagline','business_address','business_phone','business_mobile',
    'business_city','business_email','business_ntn','business_strn',
    'customer_categories','vendor_categories',
    'invoice_footer','invoice_terms','invoice_default_notes','invoice_bank_details',
    'currency_symbol','default_due_days','show_tax','tax_rate','paper_size',
    'prefix_invoice','prefix_order','prefix_purchase','prefix_creditnote','prefix_debitnote',
    'auto_confirm_order','auto_deduct_stock','low_stock_threshold','fy_start_month',
    'confirm_delete','allow_invoice_edit'
  ];
  for (const k of fields) await setSetting(k, req.body[k] || '');

  if (req.user && req.user.role === 'superadmin' && req.body.session_timeout_minutes != null) {
    const n = Math.max(1, Math.min(1440, parseInt(req.body.session_timeout_minutes, 10) || 15));
    await setSetting('session_timeout_minutes', String(n));
  }
  res.redirect('/settings?saved=1');
}));

module.exports = router;
