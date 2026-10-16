(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const rows = $('#queue-rows');
  const workspace = $('#workspace');
  const message = $('#message');
  const details = $('#field-list');
  let csrfToken = null;
  let selected = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const dateText = value => value ? String(value).slice(0, 10) : '—';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function notify(text, kind = '') {
    message.textContent = text;
    message.className = `message ${kind}`;
    message.hidden = false;
    message.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function getCsrf() {
    if (csrfToken) return csrfToken;
    const response = await fetch('/compliance/$metadata', {
      credentials: 'same-origin', headers: { 'x-csrf-token': 'Fetch' }
    });
    if (!response.ok) throw new Error(`Could not initialise a secure session (HTTP ${response.status}).`);
    csrfToken = response.headers.get('x-csrf-token');
    if (!csrfToken || csrfToken.toLowerCase() === 'required') throw new Error('The router did not return a CSRF token.');
    return csrfToken;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('x-csrf-token', await getCsrf());
      if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) csrfToken = null;
      throw new Error(typeof data === 'object' ? data?.error?.message || data?.message || JSON.stringify(data) : data || `Request failed (HTTP ${response.status}).`);
    }
    return data;
  }

  function valueAt(row, key) { return row?.[key] ?? row?.value?.[key] ?? ''; }

  async function loadQueue() {
    $('#queue-summary').textContent = 'Loading certificates…';
    rows.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
    try {
      const data = await api("/compliance/Certificates?$filter=status%20eq%20%27PendingReview%27&$expand=supplier($select=companyName,registrationNumber,businessPartnerId)&$orderby=createdAt%20asc&$top=100");
      const items = data?.value || [];
      $('#queue-summary').textContent = `${items.length} certificate${items.length === 1 ? '' : 's'} awaiting a decision`;
      if (!items.length) {
        rows.innerHTML = '<tr><td colspan="6" class="empty">No certificates are currently pending review.</td></tr>';
        workspace.hidden = true;
        selected = null;
        return;
      }
      rows.innerHTML = items.map(item => `<tr>
        <td><strong>${esc(item.certificateNumber || 'Certificate draft')}</strong><small>${esc(item.supplier?.companyName || item.extractedEntityName || 'Unknown supplier')}</small><small>${esc(item.extractedRegistrationNumber || item.supplier?.registrationNumber || 'No registration number')}</small></td>
        <td>${esc(item.enterpriseType || '—')}</td>
        <td>${item.isNonCompliant ? 'Non-Compliant' : esc(item.beeLevel ?? '—')}</td>
        <td>${esc(dateText(item.expiryDate))}</td>
        <td>${esc(item.ocrStatus || 'NotStarted')}</td>
        <td><button class="view" type="button" data-review="${esc(item.ID)}">Review</button></td>
      </tr>`).join('');
      rows.querySelectorAll('[data-review]').forEach(button => button.addEventListener('click', () => openReview(button.dataset.review).catch(error => notify(error.message, 'error'))));
      if (selected && items.some(item => item.ID === selected.ID)) {
        selected = items.find(item => item.ID === selected.ID);
        await showSelected(selected);
      } else {
        workspace.hidden = true;
        selected = null;
      }
    } catch (error) {
      rows.innerHTML = '<tr><td colspan="6" class="empty">The review queue could not be loaded for this identity.</td></tr>';
      $('#queue-summary').textContent = 'Queue unavailable';
      notify(`${error.message} A Compliance Officer or System Administrator role is required.`, 'error');
    }
  }

  function displayPairs(certificate) {
    const supplier = certificate.supplier || {};
    const values = [
      ['Supplier', supplier.companyName || certificate.extractedEntityName],
      ['Supplier BP', supplier.businessPartnerId],
      ['Certificate number', certificate.certificateNumber],
      ['Document type', certificate.documentType],
      ['Certificate entity name', certificate.extractedEntityName],
      ['Certificate registration number', certificate.extractedRegistrationNumber],
      ['SANAS agency number', certificate.sanasAgencyNumber],
      ['Enterprise type', certificate.enterpriseType],
      ['B-BBEE level', certificate.isNonCompliant ? 'Non-Compliant' : certificate.beeLevel],
      ['Recognition factor', certificate.isNonCompliant ? 0 : certificate.recognitionFactor],
      ['Black ownership (%)', certificate.blackOwnership],
      ['Black women ownership (%)', certificate.blackWomenOwnership],
      ['Empowering supplier', certificate.empoweringSupplier],
      ['Issue date', dateText(certificate.issueDate)],
      ['Expiry date', dateText(certificate.expiryDate)],
      ['OCR status', certificate.ocrStatus],
      ['Review status', certificate.status]
    ];
    details.innerHTML = values.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${value === true ? 'Yes' : value === false ? 'No' : esc(value == null || value === '' ? '—' : value)}</dd>`).join('');
    $('#detail-title').textContent = certificate.certificateNumber || 'Certificate review';
    $('#detail-subtitle').textContent = `Supplier: ${supplier.companyName || certificate.extractedEntityName || 'Unknown'} · Submitted ${dateText(certificate.createdAt)}`;
  }

  async function showSelected(certificate) {
    if (!certificate?.ID || !uuidPattern.test(certificate.ID)) throw new Error('Invalid certificate ID.');
    selected = certificate;
    workspace.hidden = false;
    displayPairs(certificate);
    const pdf = $('#pdf-preview');
    const image = $('#image-preview');
    const unsupported = $('#unsupported-preview');
    const empty = $('#preview-empty');
    const open = $('#open-document');
    pdf.hidden = true; image.hidden = true; unsupported.hidden = true; empty.hidden = true; open.hidden = true;
    pdf.removeAttribute('src'); image.removeAttribute('src'); open.removeAttribute('href');
    $('#file-caption').textContent = 'Looking for uploaded evidence…';
    const attachmentData = await api(`/compliance/Certificates(${certificate.ID})/attachments?$select=ID,filename,mimeType,status,createdAt&$top=1`);
    const attachments = attachmentData?.value || [];
    const attachment = attachments[0];
    if (!attachment) {
      empty.hidden = false;
      empty.textContent = 'No attachment was found on this certificate. The supplier must upload supporting evidence before it can be approved.';
      $('#file-caption').textContent = 'No uploaded document';
      setDecisionButtons(false);
      return;
    }
    if (!uuidPattern.test(attachment.ID)) throw new Error('The attachment ID returned by the server was invalid.');
    const contentUrl = `/compliance/Certificates(${certificate.ID})/attachments(ID=${attachment.ID})/content`;
    $('#file-caption').textContent = `${attachment.filename || 'Uploaded evidence'} · ${attachment.mimeType || 'Unknown media type'} · Scan: ${attachment.status || 'Unknown'}`;
    open.href = contentUrl; open.hidden = false;
    if (attachment.status !== 'Clean') {
      empty.hidden = false;
      empty.textContent = `The attachment scan status is ${attachment.status || 'unknown'}. Do not approve until malware scanning reports Clean.`;
    } else if (attachment.mimeType === 'application/pdf') {
      pdf.src = contentUrl; pdf.hidden = false;
    } else if (['image/png', 'image/jpeg'].includes(attachment.mimeType)) {
      image.src = contentUrl; image.hidden = false;
    } else {
      unsupported.hidden = false;
    }
    setDecisionButtons(attachment.status === 'Clean');
  }

  function setDecisionButtons(hasCleanEvidence) {
    $('#approve').disabled = !hasCleanEvidence;
    // The reviewer must still be able to reject or request corrected evidence.
    $('#reject').disabled = false;
    $('#resubmit').disabled = false;
  }

  async function openReview(id) {
    if (!uuidPattern.test(id || '')) throw new Error('Invalid certificate ID.');
    const data = await api(`/compliance/Certificates(${id})?$expand=supplier($select=companyName,registrationNumber,businessPartnerId)`);
    const certificate = data?.value || data;
    if (!certificate || certificate.status !== 'PendingReview') throw new Error('This certificate is no longer pending review. Refresh the queue.');
    await showSelected(certificate);
    workspace.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  async function decide(action) {
    if (!selected) return;
    const remarks = $('#remarks').value.trim();
    if (action !== 'approveCertificate' && !remarks) {
      notify('A reason is required for rejection or a resubmission request.', 'error');
      $('#remarks').focus();
      return;
    }
    const labels = { approveCertificate: 'Approve certificate', rejectCertificate: 'Reject certificate', requestResubmission: 'Request resubmission' };
    const button = action === 'approveCertificate' ? $('#approve') : action === 'rejectCertificate' ? $('#reject') : $('#resubmit');
    const original = button.textContent;
    button.disabled = true; button.textContent = 'Saving decision…';
    try {
      const result = await api(`/compliance/Certificates(${selected.ID})/${action}`, {
        method: 'POST', body: JSON.stringify({ remarks: remarks || null })
      });
      notify(valueAt(result, 'message') || `${labels[action]} completed.`, 'success');
      selected = null; workspace.hidden = true; $('#remarks').value = '';
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      button.textContent = original;
      await loadQueue();
    }
  }

  $('#refresh').addEventListener('click', () => loadQueue().catch(error => notify(error.message, 'error')));
  $('#approve').addEventListener('click', () => decide('approveCertificate'));
  $('#reject').addEventListener('click', () => decide('rejectCertificate'));
  $('#resubmit').addEventListener('click', () => decide('requestResubmission'));
  loadQueue();
})();
