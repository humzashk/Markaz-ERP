// ============ DYNAMIC ITEM ROWS (Orders/Invoices/Purchases) ============

function _buildRowHtml(idx) {
  const opts = window.productsData
    ? window.productsData.map(p =>
        `<option value="${p.id}" data-packaging="${p.packaging || p.qty_per_pack || 1}" data-rate="${p.rate || p.selling_price || 0}" data-stock="${p.stock || 0}" data-commission="${p.default_commission_rate || 0}">${p.name} · Stock: ${Math.floor((p.stock||0)/Math.max(1,p.qty_per_pack||1))} Ctn</option>`
      ).join('')
    : '';
  const hideComm = !!window._hideCommission;
  const hideDisc = !!window._hideDiscount;
  return `
    <td class="text-muted small">${idx}</td>
    <td>
      <select name="product_id" class="form-select form-select-sm product-select" required onchange="onProductChange(this)">
        <option value="">— Select Product —</option>${opts}
      </select>
    </td>
    <td><input type="number" name="rate"             class="form-control form-control-sm rate-input text-center"        min="0" step="0.01" value="" required oninput="calcTotal()" placeholder="0.00"></td>
    <td><input type="number" name="packages"         class="form-control form-control-sm pkg-input text-center fw-bold"  min="0" value="" oninput="calcRow(this)" placeholder="0"></td>
    <td><input type="number" name="packaging"        class="form-control form-control-sm packaging-input text-center"   min="1" value="1" oninput="calcRow(this)"></td>
    <td><input type="number" name="quantity"         class="form-control form-control-sm qty-input text-center fw-bold text-primary" min="0" value="" required oninput="onQtyInput(this)" placeholder="0"></td>
    ${hideComm ? '<input type="hidden" name="commission_pct" value="0">' : '<td><input type="number" name="commission_pct" class="form-control form-control-sm commission-input text-center" min="0" step="0.01" max="50" value="0" oninput="calcTotal()"></td>'}
    ${hideDisc ? '<input type="hidden" name="discount_per_pack" value="0">' : '<td><input type="number" name="discount_per_pack" class="form-control form-control-sm discount-input text-center" min="0" step="0.01" value="0" oninput="calcTotal()"></td>'}
    <td class="text-center"><span class="row-amount fw-bold text-success">0.00</span></td>
    <td><button type="button" class="btn btn-sm btn-outline-danger" onclick="removeRow(this)"><i class="bi bi-x"></i></button></td>
  `;
}

function addItemRow() {
  const tbody = document.getElementById('itemsBody');
  if (!tbody) return;
  const row = tbody.insertRow();
  row.innerHTML = _buildRowHtml(tbody.rows.length);
}

function removeRow(btn) {
  btn.closest('tr').remove();
  renumberRows();
  calcTotal();
}

function renumberRows() {
  const tbody = document.getElementById('itemsBody');
  if (!tbody) return;
  Array.from(tbody.rows).forEach((row, i) => {
    row.cells[0].textContent = i + 1;
  });
}

function onProductChange(sel) {
  const row = sel.closest('tr');
  const opt = sel.options[sel.selectedIndex];
  // Optimistic fill from <option> dataset (instant)
  if (opt.dataset.packaging) row.querySelector('.packaging-input').value = opt.dataset.packaging;
  if (opt.value && opt.dataset.rate !== undefined) {
    const rateInput = row.querySelector('.rate-input');
    const curRate   = parseFloat(rateInput && rateInput.value) || 0;
    const newRate   = parseFloat(opt.dataset.rate) || 0;
    // Only auto-fill rate when: no user edit AND (field is empty or 0) AND new rate > 0
    if (rateInput && !rateInput.dataset._userEdited && curRate === 0 && newRate > 0) {
      rateInput.value = newRate.toFixed(2);
    }
  }
  if (opt.dataset.commission) {
    const commInput = row.querySelector('.commission-input');
    if (commInput && (!commInput.value || commInput.value === '0')) commInput.value = parseFloat(opt.dataset.commission) || 0;
  }
  const stockInfo = sel.parentElement.querySelector('.stock-hint');
  if (stockInfo) stockInfo.remove();
  // Clear any previous qpp-warning immediately on product change
  _setQppWarning(row, null);
  const pkgInput = row.querySelector('.packaging-input');
  if (pkgInput) pkgInput.classList.remove('border-warning', 'is-invalid');
  if (!opt.value) return calcRow(sel);

  // Async: fetch warehouse-scoped stock + best sell rate from /api/stock
  const apiBase = (window.location.pathname.indexOf('/orders') === 0) ? '/orders' :
                  (window.location.pathname.indexOf('/invoices') === 0) ? '/invoices' :
                  (window.location.pathname.indexOf('/purchases') === 0) ? null : null;
  const wid = document.querySelector('select[name="warehouse_id"]')?.value || '';
  const customerSel = document.querySelector('select[name="customer_id"]');
  const customerType = customerSel?.options[customerSel.selectedIndex]?.dataset.customerType || 'retail';
  if (apiBase) {
    fetch(`${apiBase}/api/stock/${opt.value}?warehouse_id=${wid}&customer_type=${customerType}`)
      .then(r => r.json())
      .then(d => {
        const qpp = d.qty_per_pack || 1;
        const ctn = d.stock_ctn != null ? d.stock_ctn : Math.floor((d.stock||0)/qpp);
        const loose = d.stock_loose != null ? d.stock_loose : ((d.stock||0) % qpp);
        const hint = document.createElement('small');
        const stockLow = ctn < 5;
        hint.className = 'stock-hint ' + (stockLow ? 'text-danger' : 'text-muted') + ' d-block';
        hint.innerHTML = `Stock: <strong>${ctn}</strong> Ctn${loose ? ' + '+loose+' pcs' : ''}`;
        sel.parentElement.appendChild(hint);
        // Apply rate from rate_list if backend returned one
        if (d.rate != null) {
          const rateInput = row.querySelector('.rate-input');
          if (rateInput && (!rateInput.dataset._userEdited)) rateInput.value = parseFloat(d.rate).toFixed(2);
        }
        // Stash stock on row for over-stock warning
        row.dataset.stockPcs = d.stock || 0;
        row.dataset.qtyPerPack = qpp;
        // Show qty_per_pack warning if API flagged it
        _setQppWarning(row, d.qpp_warning || null);
        calcRow(sel);
      })
      .catch(() => { /* fall back silently */ });
  } else {
    const stock = parseInt(opt.dataset.stock) || 0;
    const hint = document.createElement('small');
    hint.className = 'stock-hint text-muted d-block';
    const qppFallback = parseInt(opt.dataset.packaging, 10) || 1;
    const ctnFallback = Math.floor(stock / Math.max(1, qppFallback));
    hint.innerHTML = `Stock: <strong>${ctnFallback}</strong> Ctn`;
    sel.parentElement.appendChild(hint);
    row.dataset.stockPcs = stock;
    // Check packaging from data attribute for non-API path (purchases)
    const qpp = parseInt(opt.dataset.packaging, 10) || 1;
    row.dataset.qtyPerPack = qpp;
    if (qpp < 1) {
      _setQppWarning(row, 'Pcs/Ctn is missing or zero — check product master');
    } else if (qpp > QPP_SUSPICIOUS_HIGH) {
      _setQppWarning(row, `Pcs/Ctn = ${qpp} is unusually high — verify with product master`);
    }
    calcRow(sel);
  }
}

// ─── qty_per_pack warning badge ────────────────────────────────────────────
// Shows an orange warning on the row when Pcs/Ctn looks suspicious.
// Also fires when the user manually edits the packaging-input field.
const QPP_SUSPICIOUS_HIGH = 500;

function _setQppWarning(row, message) {
  // Remove any existing warning
  const old = row.querySelector('.qpp-warn');
  if (old) old.remove();
  if (!message) return;

  const pkgCell = row.querySelector('.packaging-input')?.closest('td');
  if (!pkgCell) return;

  const badge = document.createElement('small');
  badge.className = 'qpp-warn text-warning d-block mt-1 fw-semibold';
  badge.style.fontSize = '0.72em';
  badge.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> ${message}`;
  pkgCell.appendChild(badge);

  // Also visually tint the packaging input
  const pkgInput = row.querySelector('.packaging-input');
  if (pkgInput) pkgInput.classList.add('border-warning');
}

function _checkPackagingInput(pkgInput) {
  const row = pkgInput.closest('tr');
  if (!row) return;
  const val = parseInt(pkgInput.value, 10);
  if (!val || val < 1) {
    _setQppWarning(row, 'Pcs/Ctn must be ≥ 1');
    pkgInput.classList.add('is-invalid');
    return;
  }
  pkgInput.classList.remove('is-invalid');
  if (val > QPP_SUSPICIOUS_HIGH) {
    _setQppWarning(row, `Pcs/Ctn = ${val} is unusually high — check with product master`);
    return;
  }
  // Clear warning only if it was set by packaging-input (not by server)
  const masterQpp = parseInt(row.dataset.qtyPerPack, 10) || 0;
  if (masterQpp > 0 && val !== masterQpp) {
    _setQppWarning(row, `Pcs/Ctn changed to ${val} (product master: ${masterQpp}) — verify`);
    return;
  }
  _setQppWarning(row, null);
}

// Listen for manual packaging-input edits on the whole form
document.addEventListener('input', e => {
  if (e.target && e.target.classList && e.target.classList.contains('packaging-input')) {
    _checkPackagingInput(e.target);
    calcRow(e.target);
  }
});

// Mark rate input as user-edited so async API doesn't overwrite manual entry
document.addEventListener('input', e => {
  if (e.target && e.target.classList && e.target.classList.contains('rate-input')) {
    e.target.dataset._userEdited = '1';
  }
});

// Re-fetch all rows' stock when warehouse changes
document.addEventListener('change', e => {
  if (e.target && e.target.name === 'warehouse_id') {
    document.querySelectorAll('select.product-select').forEach(s => { if (s.value) onProductChange(s); });
  }
});

// Over-stock warning
function _checkOverStock(row) {
  const qty = parseFloat(row.querySelector('.qty-input')?.value) || 0;
  const stockPcs = parseFloat(row.dataset.stockPcs || '0') || 0;
  const cell = row.querySelector('.qty-input');
  if (!cell) return;
  if (stockPcs > 0 && qty > stockPcs) {
    const qpp2 = parseFloat(row.dataset.qtyPerPack || '1') || 1;
    const ctnAvail = Math.floor(stockPcs / qpp2);
    cell.classList.add('is-invalid');
    cell.title = 'Exceeds available stock (' + ctnAvail + ' Ctn)';
  } else {
    cell.classList.remove('is-invalid');
    cell.title = '';
  }
}

// When packages or pcs/ctn change → auto-fill qty
function calcRow(el) {
  const row = el.closest('tr');
  const pkg = parseInt(row.querySelector('.pkg-input').value) || 0;
  const packaging = parseInt(row.querySelector('.packaging-input').value) || 1;
  const qtyInput = row.querySelector('.qty-input');

  // Only auto-fill qty if user entered packages
  if (el.classList.contains('pkg-input') || el.classList.contains('packaging-input')) {
    if (pkg > 0) {
      qtyInput.value = pkg * packaging;
      qtyInput.style.background = '#e8f5e9'; // green tint = auto-calculated
    }
  }
  calcTotal();
}

// When user manually types qty → clear pkg highlight
function onQtyInput(el) {
  el.style.background = '';
  const row = el.closest('tr');
  const pkg = parseInt(row.querySelector('.pkg-input').value) || 0;
  const packaging = parseInt(row.querySelector('.packaging-input').value) || 1;
  if (el.value && packaging > 0) {
    const qty = parseInt(el.value) || 0;
    const suggestedPkg = qty / packaging;
    if (Number.isInteger(suggestedPkg) && pkg === 0) {
      row.querySelector('.pkg-input').value = suggestedPkg;
    }
  }
  _checkOverStock(row);
  calcTotal();
}

function calcTotal() {
  const tbody = document.getElementById('itemsBody');
  if (!tbody) return;
  let subtotal = 0;
  let totalCommission = 0;
  let totalDiscount = 0;
  Array.from(tbody.rows).forEach(row => {
    const qty      = parseFloat(row.querySelector('.qty-input')?.value)        || 0;
    const pkg      = parseFloat(row.querySelector('.pkg-input')?.value)         || 0;
    const rate     = parseFloat(row.querySelector('.rate-input')?.value)       || 0;
    const commPct  = parseFloat(row.querySelector('.commission-input')?.value) || 0;
    const discPack = parseFloat(row.querySelector('.discount-input')?.value)   || 0;
    const amount   = qty * rate;             // gross row amount: PCS × rate/pc
    const comm     = amount * commPct / 100; // commission deducted from this row
    const disc     = pkg * discPack;         // discount per carton × num cartons (informational)
    const amountCell = row.querySelector('.row-amount');
    if (amountCell) amountCell.textContent = amount.toLocaleString('en-PK', {minimumFractionDigits:2, maximumFractionDigits:2});
    subtotal        += amount;
    totalCommission += comm;
    totalDiscount   += disc;
  });

  const transport     = parseFloat(document.getElementById('transport_charges')?.value) || 0;
  const delivery      = parseFloat(document.getElementById('delivery_charges')?.value)  || 0;
  const discountField = parseFloat(document.getElementById('discount')?.value)          || 0;

  // Gross total = items + transport/delivery charges (before commission and header discount)
  const grossTotal = subtotal + transport + delivery;

  // NET AMOUNT matches backend:
  //  Invoices:  total = subtotal + transportCharges  - totalComm         (no #discount field)
  //  Purchases: total = subtotal + deliveryCharges   - headerDiscount    (no commission)
  // discount_per_pack is stored per item for reporting but NOT deducted from the saved total
  const netAmount  = grossTotal - totalCommission - discountField;

  const fmt = n => n.toLocaleString('en-PK', {minimumFractionDigits:2, maximumFractionDigits:2});
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('subtotal',    fmt(subtotal));
  set('grandTotal',  fmt(grossTotal));    // Gross before commission / header discount
  set('commAmount',  fmt(totalCommission));
  set('commPctDisp', totalCommission > 0 ? 'Item-wise' : '0');
  set('discAmount',  fmt(totalDiscount)); // informational only (disc/pack × cartons)
  set('grossAmount', fmt(netAmount));     // NET AMOUNT = what backend saves as `total`
}

function loadCustomerCommission(sel) {
  const opt = sel.options[sel.selectedIndex];
  const comm = parseFloat(opt.dataset.commission) || 0;
  const commPctEl = document.getElementById('commission_pct');
  if (commPctEl) {
    commPctEl.value = comm;
    calcTotal();
  }
}

// ============ CONFIRM DELETE ============
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.delete-form').forEach(form => {
    form.addEventListener('submit', e => {
      if (!confirm('Are you sure you want to delete this record?')) e.preventDefault();
    });
  });

  // ============ CLIENT-SIDE REQUIRED FIELD GUARD ============
  // Pre-flight check before save confirm — surfaces missing required fields with a clear message.
  document.querySelectorAll('form').forEach(form => {
    if (form.classList.contains('no-validate')) return;
    if ((form.getAttribute('method') || 'GET').toUpperCase() !== 'POST') return;
    form.addEventListener('submit', e => {
      if (form.dataset._validated === '1') return;
      const missing = [];
      form.querySelectorAll('[required]').forEach(el => {
        const v = (el.value || '').trim();
        if (!v) {
          const lbl = (el.closest('.mb-3')?.querySelector('label')?.textContent || el.name || 'field').replace(/\*$/,'').trim();
          missing.push(lbl);
          el.classList.add('is-invalid');
        } else {
          el.classList.remove('is-invalid');
        }
      });
      // Item-row guard: at least one row with product + quantity
      const rows = form.querySelectorAll('#itemsBody tr');
      if (rows.length) {
        let validRow = 0;
        rows.forEach(r => {
          const pid = r.querySelector('select[name="product_id"]')?.value;
          const qty = parseFloat(r.querySelector('input[name="quantity"]')?.value || '0');
          if (pid && qty > 0) validRow++;
        });
        if (validRow === 0) missing.push('At least one valid line item (product + quantity)');
      }
      if (missing.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        alert('Please provide valid values for:\n\n• ' + missing.join('\n• '));
        return;
      }
      form.dataset._validated = '1';
    });
  });

  // ============ UNIVERSAL SAVE CONFIRMATION ============
  // Any POST form that mutates data is wrapped with a confirm dialog.
  // Opt out per-form by adding class="no-confirm" or attribute data-no-confirm.
  document.querySelectorAll('form').forEach(form => {
    if (form.classList.contains('delete-form')) return;          // already handled
    if (form.classList.contains('no-confirm')) return;
    if (form.hasAttribute('data-no-confirm')) return;
    const method = (form.getAttribute('method') || 'GET').toUpperCase();
    if (method !== 'POST') return;
    // Skip search/filter forms (heuristic: contains only inputs named search/period/status/from/to/etc.)
    const action = (form.getAttribute('action') || '').toLowerCase();
    if (/\/search|\/filter|\/login|\/logout/.test(action)) return;

    form.addEventListener('submit', e => {
      if (form.dataset._confirmed === '1') return;
      e.preventDefault();
      const verb = form.dataset.confirmVerb || 'save this entry';
      if (confirm('Are you sure you want to ' + verb + '?')) {
        form.dataset._confirmed = '1';
        form.submit();
      }
    });
  });

  calcTotal();

  // ── Product search combobox init ──────────────────────────────────────────
  initAllProductSearches();

  // Patch addItemRow so every new row also gets the combobox
  if (typeof window.addItemRow === 'function') {
    const _origAdd = window.addItemRow;
    window.addItemRow = function () {
      _origAdd();
      const tbody = document.getElementById('itemsBody');
      if (tbody && tbody.rows.length) {
        const last = tbody.rows[tbody.rows.length - 1];
        const sel  = last && last.querySelector('select.product-select');
        if (sel) initProductSearch(sel);
      }
    };
  }
});

/* ============================================================
   PRODUCT SEARCH COMBOBOX
   – Wraps every select.product-select with a text-filter UI.
   – Native <select> stays hidden in the DOM → form submits normally.
   – Calls existing onProductChange() on commit → stock/rate/comm
     logic is fully preserved.
   ============================================================ */

function _psEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function initProductSearch(selectEl) {
  if (!selectEl || selectEl._psInit) return;
  selectEl._psInit = true;
  selectEl.style.display = 'none';

  const products = window.productsData || [];

  /* ── wrapper ── */
  const wrap = document.createElement('div');
  wrap.className = 'ps-wrap';
  wrap.style.cssText = 'position:relative;';
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl); // keep select in DOM for name/value submission

  /* ── search input ── */
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-control form-control-sm ps-input';
  input.placeholder = '— Search product… —';
  input.autocomplete = 'off';
  input.spellcheck = false;
  wrap.insertBefore(input, selectEl);

  // Pre-fill label when editing an existing row
  if (selectEl.value) {
    const cur = products.find(p => String(p.id) === String(selectEl.value));
    if (cur) input.value = cur.name;
  }

  /* ── dropdown list ── */
  const list = document.createElement('ul');
  list.className = 'ps-list';
  list.style.cssText = [
    'display:none', 'position:absolute', 'top:100%', 'left:0', 'right:0',
    'z-index:9999', 'background:#fff', 'border:1px solid #ced4da',
    'border-top:none', 'border-radius:0 0 4px 4px', 'max-height:240px',
    'overflow-y:auto', 'margin:0', 'padding:0', 'list-style:none',
    'box-shadow:0 6px 16px rgba(0,0,0,.14)'
  ].join(';');
  wrap.appendChild(list);

  let filtered = [];
  let activeIdx = -1;

  /* ── render ── */
  function renderList(query) {
    const q = (query || '').toLowerCase().trim();
    filtered = q ? products.filter(p => p.name.toLowerCase().includes(q)) : products.slice();
    list.innerHTML = '';
    activeIdx = -1;

    if (!filtered.length) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:7px 10px;color:#999;font-size:12px;';
      li.textContent = 'No products found';
      list.appendChild(li);
      list.style.display = '';
      return;
    }

    filtered.forEach((p, i) => {
      const ctn = Math.floor((p.stock || 0) / Math.max(1, p.qty_per_pack || 1));
      const li  = document.createElement('li');
      li.dataset.psIdx = i;
      li.style.cssText = [
        'padding:6px 10px', 'cursor:pointer', 'font-size:12px',
        'border-bottom:1px solid #f3f3f3', 'white-space:nowrap',
        'overflow:hidden', 'text-overflow:ellipsis'
      ].join(';');

      // Highlight matched fragment
      if (q) {
        const lo    = p.name.toLowerCase();
        const start = lo.indexOf(q);
        li.innerHTML = start >= 0
          ? _psEsc(p.name.slice(0, start))
            + `<strong style="color:#0d6efd;">${_psEsc(p.name.slice(start, start + q.length))}</strong>`
            + _psEsc(p.name.slice(start + q.length))
            + ` <span style="color:#999;font-size:10px;">· ${ctn} Ctn</span>`
          : _psEsc(p.name) + ` <span style="color:#999;font-size:10px;">· ${ctn} Ctn</span>`;
      } else {
        li.innerHTML = _psEsc(p.name)
          + ` <span style="color:#999;font-size:10px;">· ${ctn} Ctn</span>`;
      }

      li.addEventListener('mousedown', e => { e.preventDefault(); commit(i); });
      li.addEventListener('mouseover', ()  => highlight(i));
      list.appendChild(li);
    });

    list.style.display = '';
  }

  function highlight(idx) {
    const items = list.querySelectorAll('li[data-ps-idx]');
    items.forEach(el => { el.style.background = ''; });
    activeIdx = idx;
    if (idx >= 0 && idx < items.length) {
      items[idx].style.background = '#e8f0fe';
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  }

  function commit(idx) {
    const p = filtered[idx];
    if (!p) return;
    input.value    = p.name;
    selectEl.value = p.id;
    list.style.display = 'none';
    activeIdx = -1;
    if (typeof onProductChange === 'function') onProductChange(selectEl);
  }

  function restoreLabel() {
    if (!selectEl.value) { input.value = ''; return; }
    const cur = products.find(p => String(p.id) === String(selectEl.value));
    if (cur) input.value = cur.name;
  }

  /* ── events ── */
  input.addEventListener('focus', () => renderList(input.value));

  input.addEventListener('input', () => renderList(input.value));

  input.addEventListener('blur', () => {
    // Let mousedown fire first, then close
    setTimeout(() => { list.style.display = 'none'; restoreLabel(); }, 160);
  });

  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('li[data-ps-idx]');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.style.display === 'none') renderList(input.value);
      highlight(Math.min(activeIdx + 1, items.length - 1));

    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(Math.max(activeIdx - 1, 0));

    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0)       commit(activeIdx);
      else if (filtered.length === 1) commit(0);

    } else if (e.key === 'Escape') {
      list.style.display = 'none';
      restoreLabel();
      input.blur();

    } else if (e.key === 'Tab') {
      // Commit top match on Tab so keyboard-only entry is fast
      if (activeIdx >= 0)             commit(activeIdx);
      else if (filtered.length === 1) commit(0);
      list.style.display = 'none';
    }
  });

  // Close when clicking outside
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) list.style.display = 'none';
  }, { capture: false });
}

function initAllProductSearches() {
  document.querySelectorAll('select.product-select').forEach(initProductSearch);
}
