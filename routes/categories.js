const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/', (req, res) => {
  const regions = db.prepare(`SELECT * FROM party_categories WHERE cat_group='region' ORDER BY sort_order, name`).all();
  const customerTypes = db.prepare(`SELECT * FROM party_categories WHERE cat_group='type' AND applies_to IN ('customer','both') ORDER BY sort_order, name`).all();
  const vendorTypes = db.prepare(`SELECT * FROM party_categories WHERE cat_group='type' AND applies_to IN ('vendor','both') ORDER BY sort_order, name`).all();
  res.render('categories/index', { page: 'settings', regions, customerTypes, vendorTypes });
});

router.post('/add', (req, res) => {
  const { name, cat_group, applies_to, color } = req.body;
  db.prepare('INSERT INTO party_categories (name, cat_group, applies_to, color) VALUES (?, ?, ?, ?)').run(name.trim(), cat_group, applies_to || 'both', color || 'secondary');
  res.redirect('/categories');
});

router.post('/edit/:id', (req, res) => {
  const { name, applies_to, color } = req.body;
  db.prepare('UPDATE party_categories SET name=?, applies_to=?, color=? WHERE id=?').run(name.trim(), applies_to || 'both', color || 'secondary', req.params.id);
  res.redirect('/categories');
});

router.post('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM party_categories WHERE id=?').run(req.params.id);
  res.redirect('/categories');
});

module.exports = router;
