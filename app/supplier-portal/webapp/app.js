(() => {
  'use strict';

  const state = {
    csrf: null,
    supplierID: sessionStorage.getItem('bbbeeSupplierID') || null,
    supplierName: sessionStorage.getItem('bbbeeSupplierName') || '',
    businessPartnerId: sessionStorage.getItem('bbbeeBusinessPartnerId') || '',
    certificate: null,
    attachmentID: null,
    attachmentStatus: null,
    certificates: []
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const form = $('#certificate-form');
  const notice = $('#notice');
  const editor = $('#editor');

  function safeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function showNotice(message, kind = 'info') {
    notice.textContent = message;
    notice.className = `notice ${kind}`;
    notice.hidden = false;
    notice.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function hideNotice() { notice.hidden = true; }

  function setBusy(button, busy, busyText = 'Working…') {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.originalText;
  }

  async function getCsrfToken() {
    if (state.csrf) return state.csrf;
    const response = await fetch('/supplier/$metadata', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': 'Fetch' }
    });
    if (!response.ok) throw new Error(`Could not initialise a secure session (HTTP ${response.status}). Sign in again and reload the portal.`);
    state.csrf = response.headers.get('x-csrf-token');
    if (!state.csrf || state.csrf.toLowerCase() === 'required') {
      throw new Error('The application router did not return a CSRF token. Check the app-router route configuration.');
    }
    return state.csrf;
  }

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (mutating) {
      headers.set('x-csrf-token', await getCsrfToken());
      if (options.body !== undefined && !(options.body instanceof Blob)) headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'same-origin'
    });
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('json') ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof data === 'object'
        ? data?.error?.message || data?.message || JSON.stringify(data)
        : data;
      if (response.status === 403 || response.status === 401) state.csrf = null;
      throw new Error(message || `Request failed (HTTP ${response.status}).`);
    }
    return data;
  }

  function unwrap(data) {
    if (data == null) return data;
    if (Array.isArray(data.value)) return data.value;
    if (data.value && typeof data.value === 'object') return data.value;
    return data;
  }

  function supplierUrl() { return `/supplier/Suppliers(${state.supplierID})`; }
  function certificatesUrl() { return '/supplier/Certificates?$select=ID,createdAt,modifiedAt,certificateNumber,documentType,extractedEntityName,extractedRegistrationNumber,sanasAgencyNumber,enterpriseType,status,ocrStatus,beeLevel,isNonCompliant,blackOwnership,blackWomenOwnership,empoweringSupplier,issueDate,expiryDate,rejectionReason&$orderby=modifiedAt%20desc&$top=50'; }
  function certificateUrl(id) { return `/supplier/Certificates(${id})`; }
  function attachmentUrl(id, attachmentID) { return `${certificateUrl(id)}/attachments(ID=${attachmentID})`; }

  function showSupplier(name, businessPartnerId) {
    $('#certificates-panel').hidden = false;
    $('#supplier-summary').innerHTML = `<strong>${safeText(name || state.supplierName)}</strong><span>Supplier ID: ${safeText(state.supplierID)}</span><span>S/4HANA BP: ${safeText(businessPartnerId || state.businessPartnerId || 'Not linked')}</span>`;
    $('#supplier-panel').classList.add('linked');
    refreshCertificates().catch(error => showNotice(`Supplier was matched, but the certificate list could not be loaded: ${error.message}`, 'error'));
  }

  function saveSupplierSession(result) {
    state.supplierID = result.supplierID;
    state.supplierName = result.companyName || state.supplierName;
    state.businessPartnerId = result.businessPartnerId || '';
    sessionStorage.setItem('bbbeeSupplierID', state.supplierID);
    sessionStorage.setItem('bbbeeSupplierName', state.supplierName);
    sessionStorage.setItem('bbbeeBusinessPartnerId', state.businessPartnerId);
    const matchResult = $('#match-result');
    matchResult.hidden = false;
    matchResult.innerHTML = `<strong>Supplier matched.</strong><br>${safeText(result.message || 'Your supplier record is linked.')}<br><span class="muted">Source: ${safeText(result.source || 'Supplier registry')}</span>`;
    showSupplier(state.supplierName, state.businessPartnerId);
  }

  async function onMatch(event) {
    event.preventDefault();
    hideNotice();
    const button = $('#match-button');
    const values = Object.fromEntries(new FormData($('#match-form')).entries());
    values.companyName = String(values.companyName || '').trim();
    values.taxNumber = String(values.taxNumber || '').trim();
    values.registrationNumber = String(values.registrationNumber || '').trim();
    values.contactEmail = String(values.contactEmail || '').trim();
    if (!values.taxNumber && !values.registrationNumber) {
      showNotice('Enter either the 10-digit tax number or the CIPC registration number.', 'error');
      return;
    }
    setBusy(button, true, 'Matching…');
    try {
      const result = unwrap(await api('/supplier/matchSupplier', { method: 'POST', body: JSON.stringify(values) }));
      if (result.matched && result.supplierID) {
        saveSupplierSession(result);
        showNotice(result.message || 'Supplier matched successfully.', 'success');
      } else {
        $('#match-result').hidden = false;
        $('#match-result').innerHTML = `<strong>Onboarding review required.</strong><br>${safeText(result.message || 'No Business Partner match was found. Your request is awaiting compliance review.')}<br><span class="muted">Reference: ${safeText(result.onboardingRequestID || 'Not returned')}</span>`;
        showNotice('Your supplier was not automatically linked. The onboarding request has been staged for compliance review; do not create a second request.', 'info');
      }
    } catch (error) {
      showNotice(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  async function refreshCertificates() {
    if (!state.supplierID) return;
    const response = await api(certificatesUrl());
    state.certificates = unwrap(response) || [];
    renderCertificates();
  }

  function statusPill(status) {
    const className = String(status || 'Draft').toLowerCase().replace(/[^a-z]/g, '');
    return `<span class="pill ${className}">${safeText(status || 'Draft')}</span>`;
  }

  function renderCertificates() {
    const body = $('#certificates-rows');
    if (!state.certificates.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No certificate submissions yet. Create a draft to get started.</td></tr>';
      return;
    }
    body.innerHTML = state.certificates.map(cert => {
      const name = cert.certificateNumber || cert.extractedEntityName || 'Untitled draft';
      const mutable = ['Draft', 'Rejected'].includes(cert.status);
      const expiry = cert.expiryDate ? String(cert.expiryDate).slice(0, 10) : '—';
      return `<tr>
        <td><strong>${safeText(name)}</strong><br><span class="muted">${safeText(cert.ID)}</span></td>
        <td>${safeText(cert.enterpriseType || '—')}</td>
        <td>${cert.isNonCompliant ? 'Non-Compliant' : safeText(cert.beeLevel ?? '—')}</td>
        <td>${statusPill(cert.status)}</td>
        <td>${safeText(cert.ocrStatus || 'NotStarted')}</td>
        <td>${safeText(expiry)}</td>
        <td><button class="small-link" type="button" data-open-certificate="${safeText(cert.ID)}">${mutable ? 'Open draft' : 'View'}</button></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-open-certificate]').forEach(button => {
      button.addEventListener('click', () => openCertificate(button.dataset.openCertificate).catch(error => showNotice(error.message, 'error')));
    });
  }

  function field(name) { return form.elements.namedItem(name); }

  function fillForm(cert = {}) {
    for (const name of [
      'certificateNumber', 'enterpriseType', 'documentType', 'extractedEntityName',
      'extractedRegistrationNumber', 'sanasAgencyNumber', 'beeLevel',
      'issueDate', 'expiryDate', 'blackOwnership', 'blackWomenOwnership'
    ]) {
      field(name).value = cert[name] == null ? '' : String(cert[name]).slice(0, name.endsWith('Date') ? 10 : undefined);
    }
    field('isNonCompliant').checked = cert.isNonCompliant === true;
    field('empoweringSupplier').checked = cert.empoweringSupplier === true;
    $('#status-pill').textContent = cert.status || 'Draft';
    $('#status-pill').className = `pill ${String(cert.status || 'Draft').toLowerCase().replace(/[^a-z]/g, '')}`;
    const mutable = !cert.ID || ['Draft', 'Rejected'].includes(cert.status);
    Array.from(form.elements).forEach(element => {
      if (element.name) element.disabled = !mutable;
    });
    $('#upload-button').disabled = !mutable;
    $('#save-button').disabled = !mutable;
    $('#submit-review-button').disabled = !mutable || !cert.ID;
    $('#submit-review-button').hidden = !mutable;
    $('#upload-status').textContent = state.attachmentID ? `Attachment ${state.attachmentID} uploaded; check scan status before OCR.` : 'No document uploaded in this session.';
  }

  async function loadExistingAttachment(certificateID) {
    state.attachmentID = null;
    state.attachmentStatus = null;
    try {
      const result = unwrap(await api(`${certificateUrl(certificateID)}/attachments?$select=ID,filename,mimeType,status,createdAt&$top=1`));
      const items = Array.isArray(result) ? result : (result?.value || []);
      if (items.length) {
        state.attachmentID = items[0].ID;
        state.attachmentStatus = items[0].status || null;
        $('#upload-status').textContent = `Existing document: ${items[0].filename || 'attachment'} (${items[0].status || 'scan pending'}).`;
      } else {
        $('#upload-status').textContent = 'No document uploaded in this session.';
      }
    } catch {
      // Attachment metadata may be hidden on a record with no uploaded file; upload remains available.
      $('#upload-status').textContent = 'No document metadata was returned. Upload a document to continue.';
    }
  }

  async function openCertificate(id) {
    const cert = state.certificates.find(item => item.ID === id);
    if (!cert) return;
    state.certificate = { ...cert };
    state.attachmentID = null;
    state.attachmentStatus = null;
    $('#editor-title').textContent = cert.certificateNumber || 'Certificate draft';
    fillForm(cert);
    editor.hidden = false;
    editor.scrollIntoView({ block: 'start', behavior: 'smooth' });
    await loadExistingAttachment(id);
  }

  function startDraft() {
    if (!state.supplierID) {
      showNotice('Match your supplier record before creating a certificate.', 'error');
      return;
    }
    state.certificate = null;
    state.attachmentID = null;
    state.attachmentStatus = null;
    $('#editor-title').textContent = 'New draft';
    form.reset();
    fillForm({ status: 'Draft' });
    $('#submit-review-button').disabled = true;
    $('#document-file').value = '';
    editor.hidden = false;
    editor.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function formDataForCertificate() {
    const numeric = name => field(name).value.trim() === '' ? null : Number(field(name).value);
    const date = name => field(name).value || null;
    return {
      certificateNumber: field('certificateNumber').value.trim() || null,
      documentType: field('documentType').value || null,
      extractedEntityName: field('extractedEntityName').value.trim() || null,
      extractedRegistrationNumber: field('extractedRegistrationNumber').value.trim() || null,
      sanasAgencyNumber: field('sanasAgencyNumber').value.trim() || null,
      enterpriseType: field('enterpriseType').value || null,
      beeLevel: numeric('beeLevel'),
      isNonCompliant: field('isNonCompliant').checked,
      blackOwnership: numeric('blackOwnership'),
      blackWomenOwnership: numeric('blackWomenOwnership'),
      empoweringSupplier: field('empoweringSupplier').checked,
      issueDate: date('issueDate'),
      expiryDate: date('expiryDate')
    };
  }

  async function saveDraft({ quiet = false } = {}) {
    if (!state.supplierID) throw new Error('Match your supplier before saving a certificate.');
    const payload = formDataForCertificate();
    const button = $('#save-button');
    setBusy(button, true, 'Saving…');
    try {
      let saved;
      if (state.certificate?.ID) {
        saved = unwrap(await api(certificateUrl(state.certificate.ID), { method: 'PATCH', body: JSON.stringify(payload) }));
        state.certificate = { ...state.certificate, ...payload, ...(saved || {}) };
      } else {
        saved = unwrap(await api('/supplier/Certificates', { method: 'POST', body: JSON.stringify({ supplier_ID: state.supplierID, ...payload }) }));
        state.certificate = { ...payload, ...(saved || {}) };
      }
      if (!state.certificate?.ID) throw new Error('The server did not return a certificate ID after saving.');
      $('#editor-title').textContent = state.certificate.certificateNumber || 'Certificate draft';
      $('#submit-review-button').disabled = false;
      if (!quiet) showNotice('Draft saved. Review the details and upload the supporting document before submitting.', 'success');
      await refreshCertificates();
      return state.certificate;
    } finally {
      setBusy(button, false);
      // Approved and in-review records are still protected by the backend; visual controls are refreshed below.
      fillForm(state.certificate || {});
    }
  }

  async function waitForCleanAttachment(certificateID, attachmentID) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const data = unwrap(await api(attachmentUrl(certificateID, attachmentID)));
      if (data?.status === 'Clean') return data;
      if (['Infected', 'Failed', 'Rejected'].includes(data?.status)) {
        throw new Error(`The document scan returned ${data.status}. Do not submit this file; upload a clean document.`);
      }
      await new Promise(resolve => setTimeout(resolve, 1250));
    }
    return null;
  }

  function applyOCR(fields) {
    const mapping = {
      certificateNumber: 'certificateNumber',
      extractedEntityName: 'extractedEntityName',
      extractedRegistrationNumber: 'extractedRegistrationNumber',
      sanasAgencyNumber: 'sanasAgencyNumber',
      enterpriseType: 'enterpriseType',
      beeLevel: 'beeLevel',
      isNonCompliant: 'isNonCompliant',
      blackOwnership: 'blackOwnership',
      blackWomenOwnership: 'blackWomenOwnership',
      empoweringSupplier: 'empoweringSupplier',
      issueDate: 'issueDate',
      expiryDate: 'expiryDate'
    };
    for (const [source, target] of Object.entries(mapping)) {
      if (fields[source] === null || fields[source] === undefined) continue;
      if (target === 'isNonCompliant' || target === 'empoweringSupplier') field(target).checked = fields[source] === true;
      else field(target).value = fields[source] == null ? '' : String(fields[source]).slice(0, target.endsWith('Date') ? 10 : undefined);
    }
  }

  async function analyseDocument(certificateID, attachmentID) {
    $('#upload-status').textContent = 'Sending document fields to Azure Document Intelligence…';
    const response = unwrap(await api('/compliance/analyzeCertificate', {
      method: 'POST', body: JSON.stringify({ certificateID, attachmentID })
    }));
    $('#upload-status').textContent = response.message || `OCR status: ${response.ocrStatus || 'Unknown'}`;
    if (response.ocrStatus === 'Succeeded') {
      applyOCR(response);
      state.certificate = { ...state.certificate, ...response };
      showNotice('OCR extraction completed. Review each value, correct any mistakes, save your draft, then submit for review.', 'success');
      await refreshCertificates();
    } else {
      showNotice(response.message || 'OCR did not complete. Review the attachment and retry when it is scan-clean.', 'error');
    }
  }

  async function uploadDocument() {
    hideNotice();
    const file = $('#document-file').files?.[0];
    const button = $('#upload-button');
    setBusy(button, true, 'Uploading…');
    try {
      const cert = state.certificate?.ID ? state.certificate : await saveDraft({ quiet: true });
      const certID = cert.ID;
      if (file) {
        const allowed = ['application/pdf', 'image/png', 'image/jpeg'];
        if (!allowed.includes(file.type)) throw new Error('Use a PDF, PNG or JPEG document.');
        if (file.size > 10 * 1024 * 1024) throw new Error('The selected file exceeds the 10 MB limit.');
        $('#upload-status').textContent = 'Creating attachment record…';
        let meta;
        if (state.attachmentID) {
          meta = unwrap(await api(attachmentUrl(certID, state.attachmentID), {
            method: 'PATCH', body: JSON.stringify({ filename: file.name, mimeType: file.type })
          }));
          meta = { ID: state.attachmentID, ...(meta || {}) };
        } else {
          meta = unwrap(await api(`${certificateUrl(certID)}/attachments`, {
            method: 'POST', body: JSON.stringify({ filename: file.name, mimeType: file.type })
          }));
          if (!meta?.ID) throw new Error('The server did not return an attachment ID.');
          state.attachmentID = meta.ID;
        }
        $('#upload-status').textContent = 'Uploading the document bytes…';
        const token = await getCsrfToken();
        const uploaded = await fetch(`${certificateUrl(certID)}/attachments(ID=${state.attachmentID})/content`, {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'x-csrf-token': token, 'Content-Type': file.type }, body: file
        });
        if (!uploaded.ok) {
          const detail = await uploaded.text();
          throw new Error(detail || `Document upload failed (HTTP ${uploaded.status}).`);
        }
        state.attachmentStatus = null;
        $('#document-file').value = '';
      }
      if (!state.attachmentID) throw new Error('Choose a document to upload first.');
      $('#upload-status').textContent = 'Waiting for the malware scan…';
      const attachment = await waitForCleanAttachment(certID, state.attachmentID);
      if (!attachment) {
        state.attachmentStatus = null;
        $('#upload-status').textContent = `Attachment ${state.attachmentID} is uploaded; scan is still pending. Click “Upload & analyse” again after the scan completes.`;
        return;
      }
      state.attachmentStatus = attachment.status || null;
      $('#upload-status').textContent = `Scan status: ${attachment.status}. Starting OCR…`;
      await analyseDocument(certID, state.attachmentID);
    } catch (error) {
      $('#upload-status').textContent = error.message;
      showNotice(error.message, 'error');
    } finally {
      setBusy(button, false);
      await refreshCertificates().catch(() => {});
    }
  }

  async function submitForReview() {
    if (!state.certificate?.ID) return;
    hideNotice();
    const button = $('#submit-review-button');
    setBusy(button, true, 'Submitting…');
    try {
      await saveDraft({ quiet: true });
      if (!state.attachmentID) throw new Error('Upload the certificate or affidavit evidence before submitting for review.');
      const attachment = unwrap(await api(attachmentUrl(state.certificate.ID, state.attachmentID)));
      state.attachmentStatus = attachment?.status || null;
      if (state.attachmentStatus !== 'Clean') throw new Error(`The evidence must pass malware scanning before submission. Current status: ${state.attachmentStatus || 'unknown'}.`);
      const result = unwrap(await api(`${certificateUrl(state.certificate.ID)}/submitForReview`, {
        method: 'POST', body: JSON.stringify({})
      }));
      showNotice(result.message || 'Certificate submitted for compliance review.', 'success');
      editor.hidden = true;
      state.certificate = null;
      state.attachmentID = null;
      state.attachmentStatus = null;
      await refreshCertificates();
    } catch (error) {
      showNotice(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  async function restoreSupplier() {
    if (!state.supplierID) return;
    try {
      const supplier = unwrap(await api(supplierUrl()));
      if (!supplier?.ID) throw new Error('Supplier record was not returned.');
      state.supplierName = supplier.companyName || state.supplierName;
      state.businessPartnerId = supplier.businessPartnerId || state.businessPartnerId;
      showSupplier(state.supplierName, state.businessPartnerId);
      $('#match-result').hidden = false;
      $('#match-result').innerHTML = `<strong>Supplier record restored.</strong><br>Your supplier link is available for this signed-in session.`;
      const matchForm = $('#match-form');
      matchForm.elements.namedItem('companyName').value = state.supplierName;
      matchForm.elements.namedItem('taxNumber').value = supplier.taxNumber || '';
      matchForm.elements.namedItem('registrationNumber').value = supplier.registrationNumber || '';
      matchForm.elements.namedItem('contactEmail').value = supplier.contactEmail || '';
    } catch (error) {
      sessionStorage.removeItem('bbbeeSupplierID');
      sessionStorage.removeItem('bbbeeSupplierName');
      sessionStorage.removeItem('bbbeeBusinessPartnerId');
      state.supplierID = null;
      state.supplierName = '';
      state.businessPartnerId = '';
      showNotice(`Your saved supplier session could not be restored. Match your supplier again. ${error.message}`, 'info');
    }
  }

  field('enterpriseType').addEventListener('change', () => {
    const type = field('enterpriseType').value;
    if (type === 'EME') field('documentType').value = 'EME_AFFIDAVIT';
    else if (type === 'GEN') field('documentType').value = 'GENERIC_SANAS_CERTIFICATE';
    else if (type === 'QSE' && !['QSE_AFFIDAVIT', 'QSE_SCORECARD'].includes(field('documentType').value)) field('documentType').value = '';
    else if (!type) field('documentType').value = '';
  });

  $('#match-form').addEventListener('submit', onMatch);
  $('#refresh-button').addEventListener('click', () => refreshCertificates().then(() => showNotice('Certificate list refreshed.', 'success')).catch(error => showNotice(error.message, 'error')));
  $('#new-draft-button').addEventListener('click', startDraft);
  $('#certificate-form').addEventListener('submit', event => {
    event.preventDefault();
    saveDraft().catch(error => showNotice(error.message, 'error'));
  });
  $('#upload-button').addEventListener('click', uploadDocument);
  $('#submit-review-button').addEventListener('click', submitForReview);
  $('#close-editor-button').addEventListener('click', () => { editor.hidden = true; state.certificate = null; state.attachmentID = null; state.attachmentStatus = null; });

  restoreSupplier();
})();
