(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const message = $('#message');
  let csrf;
  function notify(text, kind = '') { message.textContent = text; message.className = `message ${kind}`; message.hidden = false; }
  async function token() {
    if (csrf) return csrf;
    const response = await fetch('/compliance/$metadata', { credentials: 'same-origin', headers: { 'x-csrf-token': 'Fetch' } });
    if (!response.ok) throw new Error(`Could not start a secure session (HTTP ${response.status}).`);
    csrf = response.headers.get('x-csrf-token');
    if (!csrf || csrf.toLowerCase() === 'required') throw new Error('The app router did not return a CSRF token.');
    return csrf;
  }
  async function call(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const mutating = !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase());
    if (mutating) { headers.set('x-csrf-token', await token()); headers.set('Content-Type', 'application/json'); }
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(typeof data === 'object' ? data?.error?.message || data?.message || JSON.stringify(data) : data);
    return data;
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function value(data, key) { return data?.[key] ?? data?.value?.[key] ?? ''; }
  async function load() {
    $('#rows').innerHTML = '<tr><td colspan="6" class="empty">Loading onboarding requests…</td></tr>';
    try {
      const data = await call("/compliance/SupplierOnboardingRequests?$filter=status%20eq%20'Pending'&$orderby=createdAt%20desc&$top=100");
      const items = data?.value || [];
      $('#count').textContent = `(${items.length})`;
      if (!items.length) { $('#rows').innerHTML = '<tr><td colspan="6" class="empty">No pending onboarding requests are visible to this identity.</td></tr>'; return; }
      $('#rows').innerHTML = items.map(item => `<tr>
        <td><strong>${esc(item.proposedCompanyName)}</strong><small class="status">${esc(item.status)}</small></td>
        <td><small>Tax: ${esc(item.taxNumber || 'Not supplied')}</small><small>CIPC: ${esc(item.registrationNumber || 'Not supplied')}</small></td>
        <td>${esc(item.contactEmail || 'No email supplied')}</td>
        <td>${esc(item.createdAt ? String(item.createdAt).slice(0,10) : '—')}</td>
        <td>${esc(item.reviewNotes || 'No prior review notes')}</td>
        <td><div class="actions"><button class="btn approve" data-approve="${esc(item.ID)}">Approve</button><button class="btn reject" data-reject="${esc(item.ID)}">Reject</button></div></td>
      </tr>`).join('');
      $('#rows').querySelectorAll('[data-approve]').forEach(button => button.addEventListener('click', () => approve(button.dataset.approve)));
      $('#rows').querySelectorAll('[data-reject]').forEach(button => button.addEventListener('click', () => reject(button.dataset.reject)));
    } catch (error) {
      $('#rows').innerHTML = '<tr><td colspan="6" class="empty">The queue could not be loaded.</td></tr>';
      notify(`${error.message}. A System Administrator role is required for onboarding decisions.`, 'error');
    }
  }
  async function approve(id) {
    const businessPartnerId = prompt('Enter the confirmed S/4HANA Business Partner ID. Leave blank to retry the identifier lookup:');
    if (businessPartnerId === null) return;
    const remarks = prompt('Approval note (optional):', 'Identifiers verified and supplier linked.');
    if (remarks === null) return;
    try {
      const result = await call(`/compliance/SupplierOnboardingRequests(${id})/approveOnboardingRequest`, {
        method: 'POST', body: JSON.stringify({ businessPartnerId: businessPartnerId.trim() || null, remarks: remarks.trim() || null })
      });
      notify(value(result, 'message') || 'Supplier onboarding approved.', 'success');
      await load();
    } catch (error) { notify(error.message, 'error'); }
  }
  async function reject(id) {
    const remarks = prompt('Reason for rejecting this onboarding request (required):');
    if (remarks === null) return;
    if (!remarks.trim()) { notify('A rejection reason is required.', 'error'); return; }
    try {
      const result = await call(`/compliance/SupplierOnboardingRequests(${id})/rejectOnboardingRequest`, {
        method: 'POST', body: JSON.stringify({ remarks: remarks.trim() })
      });
      notify(value(result, 'message') || 'Onboarding request rejected.', 'success');
      await load();
    } catch (error) { notify(error.message, 'error'); }
  }
  $('#refresh').addEventListener('click', load);
  load();
})();
