sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageBox) {
  "use strict";

  const CERTIFICATE_FIELDS = [
    "certificateNumber", "documentType", "extractedEntityName", "extractedRegistrationNumber",
    "sanasAgencyNumber", "enterpriseType", "beeLevel", "isNonCompliant", "blackOwnership",
    "blackWomenOwnership", "empoweringSupplier", "issueDate", "expiryDate"
  ];
  const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  return Controller.extend("za.co.bbbee.supplierportal.controller.Main", {
    onInit: function () {
      this._csrfToken = null;
      this._certificate = null;
      this._attachmentID = null;
      this._attachmentStatus = null;
      this._model = new JSONModel({
        linked: false,
        matching: false,
        supplierID: sessionStorage.getItem("bbbeeSupplierID") || "",
        supplierName: sessionStorage.getItem("bbbeeSupplierName") || "",
        businessPartnerId: sessionStorage.getItem("bbbeeBusinessPartnerId") || "",
        supplierStatusText: "No supplier linked",
        supplierStatusState: "Information",
        supplierMessage: "Enter your registered details to match your existing supplier record.",
        match: { companyName: "", taxNumber: "", registrationNumber: "", contactEmail: "" },
        matchResultVisible: false,
        matchResultText: "",
        messageVisible: false,
        messageText: "",
        messageType: "Information",
        certificates: [],
        editorTitle: "New certificate draft",
        editorEditable: true,
        canSubmit: false,
        editor: this._emptyEditor(),
        attachmentStatusText: "No evidence uploaded",
        attachmentStatusState: "None",
        uploadMessage: "PDF, PNG or JPEG documents up to 10 MB are accepted.",
        matchExpanded: true
      });
      this.getView().setModel(this._model, "state");
      if (this._model.getProperty("/supplierID")) {
        this._restoreSupplier().catch((error) => this._notify(error.message, "Error"));
      }
    },

    _emptyEditor: function () {
      return {
        ID: "", status: "Draft", statusState: "Information", rejectionReason: "",
        certificateNumber: "", documentType: "", extractedEntityName: "", extractedRegistrationNumber: "",
        sanasAgencyNumber: "", enterpriseType: "", beeLevel: "", isNonCompliant: false,
        blackOwnership: "", blackWomenOwnership: "", empoweringSupplier: false, issueDate: "", expiryDate: ""
      };
    },

    _notify: function (message, type) {
      this._model.setProperty("/messageText", String(message || ""));
      this._model.setProperty("/messageType", type || "Information");
      this._model.setProperty("/messageVisible", true);
    },

    _hideNotice: function () { this._model.setProperty("/messageVisible", false); },

    _unwrap: function (data) {
      if (data == null) return data;
      if (data.value && typeof data.value === "object") return data.value;
      return data;
    },

    _getCsrfToken: async function () {
      if (this._csrfToken) return this._csrfToken;
      const response = await fetch("/supplier/$metadata", {
        credentials: "same-origin",
        headers: { "x-csrf-token": "Fetch" }
      });
      if (!response.ok) throw new Error(`Could not initialise a secure session (HTTP ${response.status}). Sign in again and reload.`);
      this._csrfToken = response.headers.get("x-csrf-token");
      if (!this._csrfToken || this._csrfToken.toLowerCase() === "required") {
        throw new Error("The application router did not return a CSRF token. Check the approuter service routes.");
      }
      return this._csrfToken;
    },

    _api: async function (path, options) {
      options = options || {};
      const method = String(options.method || "GET").toUpperCase();
      const headers = new Headers(options.headers || {});
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        headers.set("x-csrf-token", await this._getCsrfToken());
        const isBlob = typeof Blob !== "undefined" && options.body instanceof Blob;
        if (options.body !== undefined && !isBlob && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      }
      const response = await fetch(path, Object.assign({}, options, {
        method: method,
        headers: headers,
        credentials: "same-origin"
      }));
      if (response.status === 204) return null;
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("json") ? await response.json() : await response.text();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this._csrfToken = null;
        const detail = typeof data === "object" ? (data?.error?.message || data?.message || JSON.stringify(data)) : data;
        throw new Error(detail || `Request failed (HTTP ${response.status}).`);
      }
      return data;
    },

    _supplierUrl: function () { return `/supplier/Suppliers(${this._model.getProperty("/supplierID")})`; },
    _certificateUrl: function (id) { return `/supplier/Certificates(${id})`; },
    _attachmentUrl: function (id, attachmentID) { return `${this._certificateUrl(id)}/attachments(ID=${attachmentID})`; },

    _statusState: function (status) {
      switch (String(status || "").toLowerCase()) {
        case "approved": case "clean": case "succeeded": return "Success";
        case "rejected": case "infected": case "failed": return "Error";
        case "pendingreview": case "pending": case "processing": case "inreview": return "Warning";
        case "draft": case "notstarted": return "Information";
        default: return "None";
      }
    },

    _persistSupplier: function (result) {
      const supplierID = result.supplierID || result.ID;
      if (!supplierID) throw new Error("The supplier match response did not include a supplier ID.");
      const companyName = result.companyName || this._model.getProperty("/supplierName") || "Supplier";
      const businessPartnerId = result.businessPartnerId || "";
      sessionStorage.setItem("bbbeeSupplierID", supplierID);
      sessionStorage.setItem("bbbeeSupplierName", companyName);
      sessionStorage.setItem("bbbeeBusinessPartnerId", businessPartnerId);
      this._model.setProperty("/supplierID", supplierID);
      this._model.setProperty("/supplierName", companyName);
      this._model.setProperty("/businessPartnerId", businessPartnerId);
      this._model.setProperty("/linked", true);
      this._model.setProperty("/supplierStatusText", "Supplier record linked");
      this._model.setProperty("/supplierStatusState", "Success");
      this._model.setProperty("/supplierMessage", result.message || "Your supplier record is linked to this workspace.");
      this._model.setProperty("/matchResultVisible", true);
      this._model.setProperty("/matchResultText", `Supplier matched. Source: ${result.source || "supplier registry"}.`);
      this._model.setProperty("/matchExpanded", false);
    },

    _restoreSupplier: async function () {
      const id = this._model.getProperty("/supplierID");
      if (!id) return;
      try {
        const supplier = this._unwrap(await this._api(this._supplierUrl()));
        if (!supplier?.ID) throw new Error("Supplier record was not returned.");
        this._persistSupplier({
          supplierID: supplier.ID,
          companyName: supplier.companyName,
          businessPartnerId: supplier.businessPartnerId,
          message: "Supplier record restored for this signed-in browser session."
        });
        this._model.setProperty("/match/companyName", supplier.companyName || "");
        this._model.setProperty("/match/taxNumber", supplier.taxNumber || "");
        this._model.setProperty("/match/registrationNumber", supplier.registrationNumber || "");
        this._model.setProperty("/match/contactEmail", supplier.contactEmail || "");
        await this._refreshCertificates();
      } catch (error) {
        sessionStorage.removeItem("bbbeeSupplierID");
        sessionStorage.removeItem("bbbeeSupplierName");
        sessionStorage.removeItem("bbbeeBusinessPartnerId");
        this._model.setProperty("/supplierID", "");
        this._model.setProperty("/linked", false);
        this._model.setProperty("/supplierStatusText", "Supplier link unavailable");
        this._model.setProperty("/supplierStatusState", "Warning");
        this._notify(`The saved supplier link could not be restored: ${error.message}. Match the supplier again if required.`, "Warning");
      }
    },

    onMatchSupplier: async function () {
      this._hideNotice();
      const values = this._model.getProperty("/match") || {};
      const payload = {
        companyName: String(values.companyName || "").trim(),
        taxNumber: String(values.taxNumber || "").trim(),
        registrationNumber: String(values.registrationNumber || "").trim(),
        contactEmail: String(values.contactEmail || "").trim()
      };
      if (!payload.companyName || !payload.contactEmail) {
        this._notify("Enter the registered company name and a contact email.", "Error");
        return;
      }
      if (!payload.taxNumber && !payload.registrationNumber) {
        this._notify("Enter either the 10-digit tax number or the CIPC registration number.", "Error");
        return;
      }
      if (payload.taxNumber && !/^\d{10}$/.test(payload.taxNumber)) {
        this._notify("The South African tax number must contain 10 digits.", "Error");
        return;
      }
      this._model.setProperty("/matching", true);
      this.getView().setBusy(true);
      try {
        const result = this._unwrap(await this._api("/supplier/matchSupplier", {
          method: "POST", body: JSON.stringify(payload)
        }));
        if (result?.matched && result?.supplierID) {
          this._persistSupplier(result);
          await this._refreshCertificates();
          this._notify(result.message || "Supplier matched successfully.", "Success");
        } else {
          this._model.setProperty("/matchResultVisible", true);
          this._model.setProperty("/matchResultText", `${result?.message || "No automatic Business Partner match was found."} Reference: ${result?.onboardingRequestID || "not returned"}.`);
          this._notify("Your request has been staged for compliance onboarding review. Do not submit a duplicate request while it is pending.", "Information");
        }
      } catch (error) {
        this._notify(error.message, "Error");
      } finally {
        this.getView().setBusy(false);
        this._model.setProperty("/matching", false);
      }
    },

    onRefresh: function () {
      if (this._model.getProperty("/linked")) this._refreshCertificates().catch((error) => this._notify(error.message, "Error"));
      else this._restoreSupplier();
    },
    onRefreshCertificates: function () { this._refreshCertificates().catch((error) => this._notify(error.message, "Error")); },

    _refreshCertificates: async function () {
      if (!this._model.getProperty("/supplierID")) return;
      this.getView().setBusy(true);
      try {
        const data = await this._api("/supplier/Certificates?$select=ID,createdAt,modifiedAt,certificateNumber,documentType,extractedEntityName,extractedRegistrationNumber,sanasAgencyNumber,enterpriseType,status,ocrStatus,beeLevel,isNonCompliant,blackOwnership,blackWomenOwnership,empoweringSupplier,issueDate,expiryDate,rejectionReason&$orderby=modifiedAt%20desc&$top=50");
        const items = Array.isArray(data?.value) ? data.value : (Array.isArray(data) ? data : []);
        items.forEach((item) => {
          item.statusState = this._statusState(item.status);
          item.ocrState = this._statusState(item.ocrStatus);
          item.expiryDate = item.expiryDate ? String(item.expiryDate).slice(0, 10) : "";
          item.mutable = ["Draft", "Rejected"].includes(item.status);
        });
        this._model.setProperty("/certificates", items);
      } finally {
        this.getView().setBusy(false);
      }
    },

    onNewDraft: function () {
      if (!this._model.getProperty("/supplierID")) {
        this._notify("Match your supplier record before creating a certificate.", "Error");
        return;
      }
      this._certificate = null;
      this._attachmentID = null;
      this._attachmentStatus = null;
      this._model.setProperty("/editorTitle", "New certificate draft");
      this._model.setProperty("/editor", this._emptyEditor());
      this._model.setProperty("/editorEditable", true);
      this._model.setProperty("/canSubmit", false);
      this._setAttachmentStatus("No evidence uploaded", "None");
      this._model.setProperty("/uploadMessage", "PDF, PNG or JPEG documents up to 10 MB are accepted.");
      this.byId("fileUploader").clear();
      this.byId("editorDialog").open();
    },

    onCertificatePress: async function (event) {
      const item = event.getSource().getBindingContext("state").getObject();
      this._certificate = Object.assign({}, item);
      this._attachmentID = null;
      this._attachmentStatus = null;
      this._model.setProperty("/editorTitle", item.certificateNumber || item.extractedEntityName || "Certificate record");
      this._setEditor(item);
      this.byId("editorDialog").open();
      await this._loadExistingAttachment(item.ID);
    },

    _setEditor: function (certificate) {
      const editor = this._emptyEditor();
      CERTIFICATE_FIELDS.forEach((field) => {
        let value = certificate[field];
        if (value === null || value === undefined) value = "";
        if (field.endsWith("Date") && value) value = String(value).slice(0, 10);
        if (field === "beeLevel" && value !== "") value = String(value);
        editor[field] = value;
      });
      editor.ID = certificate.ID || "";
      editor.status = certificate.status || "Draft";
      editor.statusState = this._statusState(editor.status);
      editor.rejectionReason = certificate.rejectionReason || "";
      const mutable = !certificate.ID || ["Draft", "Rejected"].includes(certificate.status);
      this._model.setProperty("/editor", editor);
      this._model.setProperty("/editorEditable", mutable);
      this._model.setProperty("/canSubmit", mutable && Boolean(certificate.ID));
      this._model.setProperty("/editorTitle", certificate.certificateNumber || "Certificate draft");
    },

    _loadExistingAttachment: async function (certificateID) {
      try {
        const data = await this._api(`${this._certificateUrl(certificateID)}/attachments?$select=ID,filename,mimeType,status,createdAt&$top=1`);
        const items = Array.isArray(data?.value) ? data.value : (Array.isArray(data) ? data : []);
        const attachment = items[0];
        if (!attachment) {
          this._setAttachmentStatus("No uploaded evidence", "Warning");
          this._model.setProperty("/uploadMessage", "Upload the supporting PDF, PNG or JPEG before submitting for review.");
          return;
        }
        this._attachmentID = attachment.ID;
        this._attachmentStatus = attachment.status || null;
        this._setAttachmentStatus(`Evidence scan: ${attachment.status || "unknown"}`, this._statusState(attachment.status));
        this._model.setProperty("/uploadMessage", `${attachment.filename || "Uploaded evidence"} · ${attachment.mimeType || "unknown file type"}`);
      } catch (error) {
        this._setAttachmentStatus("Evidence metadata unavailable", "Warning");
        this._model.setProperty("/uploadMessage", error.message);
      }
    },

    _setAttachmentStatus: function (text, state) {
      this._model.setProperty("/attachmentStatusText", text);
      this._model.setProperty("/attachmentStatusState", state || "None");
    },

    _certificatePayload: function () {
      const editor = this._model.getProperty("/editor") || {};
      const number = (name) => {
        const raw = editor[name];
        if (raw === "" || raw === null || raw === undefined || String(raw).trim() === "") return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const stringOrNull = (name) => String(editor[name] || "").trim() || null;
      return {
        certificateNumber: stringOrNull("certificateNumber"),
        documentType: stringOrNull("documentType"),
        extractedEntityName: stringOrNull("extractedEntityName"),
        extractedRegistrationNumber: stringOrNull("extractedRegistrationNumber"),
        sanasAgencyNumber: stringOrNull("sanasAgencyNumber"),
        enterpriseType: stringOrNull("enterpriseType"),
        beeLevel: number("beeLevel"),
        isNonCompliant: editor.isNonCompliant === true,
        blackOwnership: number("blackOwnership"),
        blackWomenOwnership: number("blackWomenOwnership"),
        empoweringSupplier: editor.empoweringSupplier === true,
        issueDate: editor.issueDate || null,
        expiryDate: editor.expiryDate || null
      };
    },

    _saveDraft: async function (quiet) {
      const supplierID = this._model.getProperty("/supplierID");
      if (!supplierID) throw new Error("Match your supplier before saving a certificate.");
      const payload = this._certificatePayload();
      let saved;
      if (this._certificate?.ID) {
        saved = this._unwrap(await this._api(this._certificateUrl(this._certificate.ID), {
          method: "PATCH", body: JSON.stringify(payload)
        }));
        this._certificate = Object.assign({}, this._certificate, payload, saved || {});
      } else {
        saved = this._unwrap(await this._api("/supplier/Certificates", {
          method: "POST", body: JSON.stringify(Object.assign({ supplier_ID: supplierID }, payload))
        }));
        this._certificate = Object.assign({}, payload, saved || {});
      }
      if (!this._certificate?.ID) throw new Error("The service did not return a certificate ID after saving the draft.");
      this._setEditor(this._certificate);
      this._model.setProperty("/canSubmit", ["Draft", "Rejected"].includes(this._certificate.status || "Draft"));
      if (!quiet) this._notify("Draft saved. Review the details and upload the supporting evidence before submitting.", "Success");
      await this._refreshCertificates();
      return this._certificate;
    },

    onSaveDraft: async function () {
      this.getView().setBusy(true);
      try { await this._saveDraft(false); }
      catch (error) { this._notify(error.message, "Error"); }
      finally { this.getView().setBusy(false); }
    },

    _readSelectedFile: function () {
      const uploader = this.byId("fileUploader");
      const input = uploader && (uploader.getFocusDomRef() || uploader.oFileUpload);
      return input?.files?.[0] || null;
    },

    onUploadAndAnalyse: async function () {
      this._hideNotice();
      this.getView().setBusy(true);
      try {
        const certificate = this._certificate?.ID ? this._certificate : await this._saveDraft(true);
        const file = this._readSelectedFile();
        if (file) {
          if (!ALLOWED_TYPES.includes(file.type)) throw new Error("Use a PDF, PNG or JPEG document.");
          if (file.size > MAX_FILE_BYTES) throw new Error("The selected file exceeds the 10 MB limit.");
          this._model.setProperty("/uploadMessage", "Creating attachment record…");
          let metadata;
          if (this._attachmentID) {
            metadata = this._unwrap(await this._api(this._attachmentUrl(certificate.ID, this._attachmentID), {
              method: "PATCH", body: JSON.stringify({ filename: file.name, mimeType: file.type })
            }));
          } else {
            metadata = this._unwrap(await this._api(`${this._certificateUrl(certificate.ID)}/attachments`, {
              method: "POST", body: JSON.stringify({ filename: file.name, mimeType: file.type })
            }));
            if (!metadata?.ID) throw new Error("The service did not return an attachment ID.");
            this._attachmentID = metadata.ID;
          }
          this._model.setProperty("/uploadMessage", "Uploading document bytes…");
          const response = await fetch(`${this._certificateUrl(certificate.ID)}/attachments(ID=${this._attachmentID})/content`, {
            method: "PUT", credentials: "same-origin",
            headers: { "x-csrf-token": await this._getCsrfToken(), "Content-Type": file.type }, body: file
          });
          if (!response.ok) throw new Error((await response.text()) || `Document upload failed (HTTP ${response.status}).`);
          this.byId("fileUploader").clear();
        }
        if (!this._attachmentID) throw new Error("Choose a PDF, PNG or JPEG document before uploading.");
        this._model.setProperty("/uploadMessage", "Waiting for the evidence scan to complete…");
        const attachment = await this._waitForCleanAttachment(certificate.ID, this._attachmentID);
        if (!attachment) {
          this._setAttachmentStatus("Scan still pending", "Warning");
          this._model.setProperty("/uploadMessage", "The file is uploaded, but the scan is still pending. Retry after the scan completes.");
          return;
        }
        this._attachmentStatus = attachment.status;
        this._setAttachmentStatus(`Evidence scan: ${attachment.status}`, this._statusState(attachment.status));
        if (attachment.status !== "Clean") throw new Error(`The evidence scan returned ${attachment.status || "an unknown status"}. Do not submit this file.`);
        await this._analyseDocument(certificate.ID, this._attachmentID);
      } catch (error) {
        this._model.setProperty("/uploadMessage", error.message);
        this._notify(error.message, "Error");
      } finally {
        this.getView().setBusy(false);
        this._refreshCertificates().catch(() => {});
      }
    },

    _waitForCleanAttachment: async function (certificateID, attachmentID) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const attachment = this._unwrap(await this._api(this._attachmentUrl(certificateID, attachmentID)));
        if (attachment?.status === "Clean") return attachment;
        if (["Infected", "Failed", "Rejected"].includes(attachment?.status)) {
          throw new Error(`The document scan returned ${attachment.status}. Upload a clean document instead.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1250));
      }
      return null;
    },

    _analyseDocument: async function (certificateID, attachmentID) {
      this._model.setProperty("/uploadMessage", "Analysing certificate fields…");
      const result = this._unwrap(await this._api("/compliance/analyzeCertificate", {
        method: "POST", body: JSON.stringify({ certificateID: certificateID, attachmentID: attachmentID })
      }));
      this._model.setProperty("/uploadMessage", result.message || `OCR status: ${result.ocrStatus || "unknown"}`);
      if (result.ocrStatus !== "Succeeded") {
        this._notify(result.message || "OCR did not complete. Check the evidence and try again when appropriate.", "Warning");
        return;
      }
      const editor = Object.assign({}, this._model.getProperty("/editor"));
      CERTIFICATE_FIELDS.forEach((field) => {
        if (result[field] === null || result[field] === undefined) return;
        editor[field] = field.endsWith("Date") ? String(result[field]).slice(0, 10) : result[field];
      });
      if (editor.beeLevel !== "" && editor.beeLevel !== null) editor.beeLevel = String(editor.beeLevel);
      this._model.setProperty("/editor", editor);
      this._certificate = Object.assign({}, this._certificate || {}, result);
      this._notify("OCR extraction completed. Check every extracted value, correct mistakes, save the draft, then submit for review.", "Success");
      await this._refreshCertificates();
    },

    onSubmitForReview: async function () {
      if (!this._certificate?.ID) return;
      this.getView().setBusy(true);
      try {
        const certificate = await this._saveDraft(true);
        if (!this._attachmentID) await this._loadExistingAttachment(certificate.ID);
        if (!this._attachmentID) throw new Error("Upload the certificate or affidavit before submitting for review.");
        const attachment = this._unwrap(await this._api(this._attachmentUrl(certificate.ID, this._attachmentID)));
        this._attachmentStatus = attachment?.status || null;
        this._setAttachmentStatus(`Evidence scan: ${this._attachmentStatus || "unknown"}`, this._statusState(this._attachmentStatus));
        if (this._attachmentStatus !== "Clean") throw new Error(`Evidence must pass the malware scan before submission. Current status: ${this._attachmentStatus || "unknown"}.`);
        const result = this._unwrap(await this._api(`${this._certificateUrl(certificate.ID)}/submitForReview`, {
          method: "POST", body: JSON.stringify({})
        }));
        this.byId("editorDialog").close();
        this._certificate = null;
        this._attachmentID = null;
        this._attachmentStatus = null;
        this._notify(result?.message || "Certificate submitted for compliance review.", "Success");
        await this._refreshCertificates();
      } catch (error) {
        this._notify(error.message, "Error");
      } finally { this.getView().setBusy(false); }
    },

    onCloseEditor: function () { this.byId("editorDialog").close(); },

    onExit: function () {
      this._csrfToken = null;
    }
  });
});
