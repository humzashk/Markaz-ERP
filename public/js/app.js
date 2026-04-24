// ============ DYNAMIC ITEM ROWS (Orders/Invoices/Purchases) ============

function _buildRowHtml(idx) {
  const opts = window.productsData
    ? window.productsData.map(p =>
        `<option value="${p.id}" data-packaging="${p.packaging || p.qty_per_pack || 1}" data-rate="${p.rate || p.selling_price || 0}" data-stock="${p.stock || 0}" data-commission="${p.default_commission_rate || 0}">${p.name} · Stock: ${p.stock || 0}</option>`
      ).join('')
    : '';
  return `
    <td class="text-muted">${idx}</td>
    <td>
      <select name="product_id" class="form-select product-select" required onchange="onProductChange(this)">
        <option value="">— Select Product —</option>${opts}
      </select>
    </td>
    <td><input type="number" name="packages" class="form-control pkg-input text-center fw-bold" min="0" value="" oninput="calcRow(this)" placeholder="0"></td>
    <td><input type="number" name="packaging" class="form-control packaging-input text-center text-muted" min="1" value="1" oninput="calcRow(this)"></td>
    <td><input type="number" name="quantity" class="form-control qty-input text-center fw-bold text-primary" min="0" value="" required oninput="onQtyInput(this)" placeholder="0"></td>
    <td><input type="number" name="rate" class="form-control rate-input text-center" min="0" step="0.01" value="" required oninput="calcTotal()" placeholder="0.00"></td>
    <td><input type="number" name="discount_per_pack" class="form-control discount-input text-center" min="0" step="0.01" value="0" oninput="calcTotal()"></td>
    <td><input type="number" name="commission_pct" class="form-control commission-input text-center" min="0" step="0.01" max="100" value="0" oninput="calcTotal()"></td>
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
  if (opt.dataset.packaging) {
    row.querySelector('.packaging-input').value = opt.dataset.packaging;
  }
  // AUTO RATE: auto-fill sell rate from products master (user can still override)
  if (opt.dataset.rate) {
    const rateInput = row.querySelector('.rate-input');
    if (rateInput) rateInput.value = parseFloat(opt.dataset.rate).toFixed(2);
  }
  // Auto-fill default commission % if product has one
  if (opt.dataset.commission) {
    const commInput = row.querySelector('.commission-input');
    if (commInput && (!commInput.value || commInput.value === '0')) {
      commInput.value = parseFloat(opt.dataset.commission) || 0;
    }
  }
  // Highlight stock info
  const stock = parseInt(opt.dataset.stock) || 0;
  const stockInfo = sel.parentElement.querySelector('.stock-hint');
  if (stockInfo) stockInfo.remove();
  if (opt.value) {
    const hint = document.createElement('small');
    hint.className = 'stock-hint ' + (stock < 10 ? 'text-danger' : 'text-muted');
    hint.innerHTML = `Stock: <strong>${stock}</strong> pcs available`;
    sel.parentElement.appendChild(hint);
  }
  calcRow(sel);
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
  // Reverse: if qty entered and packaging known, suggest packages
  if (el.value && packaging > 0) {
    const qty = parseInt(el.value) || 0;
    const suggestedPkg = qty / packaging;
    if (Number.isInteger(suggestedPkg) && pkg === 0) {
      row.querySelector('.pkg-input').value = suggestedPkg;
    }
  }
  calcTotal();
}

function calcTotal() {
  const tbody = document.getElementById('itemsBody');
  if (!tbody) return;
  let subtotal = 0;
  let totalCommission = 0;
  let totalDiscount = 0;
  Array.from(tbody.rows).forEach(row => {
    const qty = parseFloat(row.querySelector('.qty-input')?.value) || 0;
    const rate = parseFloat(row.querySelector('.rate-input')?.value) || 0;
    const commPct = parseFloat(row.querySelector('.commission-input')?.value) || 0;
    const discPack = parseFloat(row.querySelector('.discount-input')?.value) || 0;
    const amount = qty * rate;
    const comm = amount * commPct / 100;
    const disc = qty * discPack;
    const amountCell = row.querySelector('.row-amount');
    if (amountCell) amountCell.textContent = amount.toLocaleString('en-PK', {minimumFractionDigits:2, maximumFractionDigits:2});
    subtotal += amount;
    totalCommission += comm;
    totalDiscount += disc;
  });

  const transport = parseFloat(document.getElementById('transport_charges')?.value) || 0;
  const grand = subtotal + transport;
  const gross = grand - totalCommission - totalDiscount;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('subtotal', subtotal.toLocaleString('en-PK', {minimumFractionDigits:2}));
  set('grandTotal', grand.toLocaleString('en-PK', {minimumFractionDigits:2}));
  set('commAmount', totalCommission.toLocaleString('en-PK', {minimumFractionDigits:2}));
  set('commPctDisp', totalCommission > 0 ? 'Item-wise' : '0');
  set('discAmount', totalDiscount.toLocaleString('en-PK', {minimumFractionDigits:2}));
  set('grossAmount', gross.toLocaleString('en-PK', {minimumFractionDigits:2}));
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
  calcTotal();
});
