sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return Controller.extend("za.co.bbbee.compliancereview.controller.Main", {
    onInit: function () {
      this._csrfToken = null;
      this._selectedCertificate = null;
      this._selectedRequest = null;
      this._model = new JSONModel({
        activeTab: new URLSearchParams(window.location.search).get("tab") === "onboarding" ? "onboarding" : "review",
        certificates: [],
        onboardingRequests: [],
        reviewCount: "0",
        onboardingCount: "0",
        reviewSummary: "Loading queue…",
        messageVisible: false,
        messageText: "",
        messageType: "Information",
        selected: {},
        selectedTitle: "Certificate review",
        selectedSubtitle: "",
        decisionRemarks: "",
        canApproveCertificate: false,
        documentUrl: "",
        documentAvailable: false,
        previewPdf: false,
        previewImage: false,
        previewMessageVisible: true,
        previewMessage: "Select a certificate to inspect its uploaded evidence.",
        previewMessageType: "Information",
        fileCaption: "No document selected",
        attachmentState: "None",
        onboardingDialogTitle: "Review supplier onboarding",
        onboardingConfirmText: "Confirm decision",
        onboardingDecision: "approve",
        onboardingRemarksRequired: false,
        businessPartnerId: "",
        onboardingRemarks: "",
        selectedRequest: {}
      });
      this.getView().setModel(this._model, "state");
      this._loadQueue().catch((error) => this._notify(error.message, "Error"));
      this._loadOnboarding().catch((error) => this._notify(error.message, "Error"));
    },

    _notify: function (message, type) {
      this._model.setProperty("/messageText", String(message || ""));
      this._model.setProperty("/messageType", type || "Information");
      this._model.setProperty("/messageVisible", true);
    },

    _hideNotice: function () { this._model.setProperty("/messageVisible", false); },

    _unwrap: function (data) {
      if (data == null) return data;
      if (data.value && !Array.isArray(data.value) && typeof data.value === "object") return data.value;
      return data;
    },

    _api: async function (path, options) {
      options = options || {};
      const method = String(options.method || "GET").toUpperCase();
      const headers = new Headers(options.headers || {});
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        headers.set("x-csrf-token", await this._getCsrfToken());
        if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      }
      const response = await fetch(path, Object.assign({}, options, {
        method: method, headers: headers, credentials: "same-origin"
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

    _getCsrfToken: async function () {
      if (this._csrfToken) return this._csrfToken;
      const response = await fetch("/compliance/$metadata", {
        credentials: "same-origin", headers: { "x-csrf-token": "Fetch" }
      });
      if (!response.ok) throw new Error(`Could not initialise a secure session (HTTP ${response.status}).`);
      this._csrfToken = response.headers.get("x-csrf-token");
      if (!this._csrfToken || this._csrfToken.toLowerCase() === "required") {
        throw new Error("The approuter did not return a CSRF token. Check the service routes and sign-in session.");
      }
      return this._csrfToken;
    },

    _statusState: function (status) {
      switch (String(status || "").toLowerCase()) {
        case "approved": case "clean": case "succeeded": case "completed": return "Success";
        case "rejected": case "infected": case "failed": return "Error";
        case "pendingreview": case "pending": case "processing": case "inreview": return "Warning";
        case "draft": case "notstarted": return "Information";
        default: return "None";
      }
    },

    onTabSelect: function (event) {
      const key = event.getParameter("key");
      this._model.setProperty("/activeTab", key);
      if (key === "onboarding") this._loadOnboarding().catch((error) => this._notify(error.message, "Error"));
      else this._loadQueue().catch((error) => this._notify(error.message, "Error"));
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", key);
        window.history.replaceState({}, "", url.toString());
      } catch (_) { /* Browser history is optional for the worklist state. */ }
    },

    onRefreshAll: function () {
      this._loadQueue().catch((error) => this._notify(error.message, "Error"));
      this._loadOnboarding().catch((error) => this._notify(error.message, "Error"));
    },
    onRefreshOnboarding: function () { this._loadOnboarding().catch((error) => this._notify(error.message, "Error")); },

    _loadQueue: async function () {
      this.getView().setBusy(true);
      this._model.setProperty("/reviewSummary", "Loading queue…");
      try {
        const data = await this._api("/compliance/Certificates?$filter=status%20eq%20%27PendingReview%27&$expand=supplier($select=companyName,registrationNumber,businessPartnerId)&$orderby=createdAt%20asc&$top=100");
        const items = Array.isArray(data?.value) ? data.value : (Array.isArray(data) ? data : []);
        items.forEach((item) => {
          item.expiryDate = item.expiryDate ? String(item.expiryDate).slice(0, 10) : "—";
          item.ocrState = this._statusState(item.ocrStatus);
          item.statusState = this._statusState(item.status);
        });
        this._model.setProperty("/certificates", items);
        this._model.setProperty("/reviewCount", String(items.length));
        this._model.setProperty("/reviewSummary", `${items.length} awaiting a decision`);
      } catch (error) {
        this._model.setProperty("/certificates", []);
        this._model.setProperty("/reviewCount", "0");
        this._model.setProperty("/reviewSummary", "Queue unavailable");
        throw new Error(`${error.message}. A Compliance Officer or System Administrator role is required to review certificates.`);
      } finally { this.getView().setBusy(false); }
    },

    _loadOnboarding: async function () {
      this.getView().setBusy(true);
      try {
        const data = await this._api("/compliance/SupplierOnboardingRequests?$filter=status%20eq%20%27Pending%27&$orderby=createdAt%20desc&$top=100");
        const items = Array.isArray(data?.value) ? data.value : (Array.isArray(data) ? data : []);
        items.forEach((item) => {
          item.createdDate = item.createdAt ? String(item.createdAt).slice(0, 10) : "—";
          item.statusState = this._statusState(item.status);
        });
        this._model.setProperty("/onboardingRequests", items);
        this._model.setProperty("/onboardingCount", String(items.length));
      } catch (error) {
        this._model.setProperty("/onboardingRequests", []);
        this._model.setProperty("/onboardingCount", "0");
        throw new Error(`${error.message}. A System Administrator role is required to decide onboarding requests.`);
      } finally { this.getView().setBusy(false); }
    },

    onReviewPress: async function (event) {
      const row = event.getSource().getBindingContext("state").getObject();
      if (!row?.ID || !UUID_PATTERN.test(row.ID)) {
        this._notify("The selected certificate ID is invalid. Refresh the worklist and try again.", "Error");
        return;
      }
      this.getView().setBusy(true);
      this._hideNotice();
      try {
        const data = this._unwrap(await this._api(`/compliance/Certificates(${row.ID})?$expand=supplier($select=companyName,registrationNumber,businessPartnerId)`));
        const certificate = data?.value || data;
        if (!certificate || certificate.status !== "PendingReview") {
          this._notify("This certificate is no longer pending review. The worklist has been refreshed.", "Warning");
          await this._loadQueue();
          return;
        }
        await this._showReview(certificate);
      } catch (error) {
        this._notify(error.message, "Error");
      } finally { this.getView().setBusy(false); }
    },

    _showReview: async function (certificate) {
      if (this._evidenceObjectUrl) URL.revokeObjectURL(this._evidenceObjectUrl);
      this._evidenceObjectUrl = null;
      this._selectedCertificate = certificate;
      const supplier = certificate.supplier || {};
      const selected = Object.assign({}, certificate, {
        statusState: this._statusState(certificate.status),
        ocrState: this._statusState(certificate.ocrStatus),
        supplierName: supplier.companyName || certificate.extractedEntityName || "Unknown supplier",
        businessPartnerId: supplier.businessPartnerId || "—",
        beeLevelText: certificate.isNonCompliant ? "Non-Compliant" : (certificate.beeLevel ?? "—"),
        empoweringSupplierText: certificate.empoweringSupplier === true ? "Yes" : certificate.empoweringSupplier === false ? "No" : "—",
        issueDate: certificate.issueDate ? String(certificate.issueDate).slice(0, 10) : "—",
        expiryDate: certificate.expiryDate ? String(certificate.expiryDate).slice(0, 10) : "—",
        blackOwnership: certificate.blackOwnership ?? "—",
        blackWomenOwnership: certificate.blackWomenOwnership ?? "—",
        recognitionFactor: certificate.isNonCompliant ? 0 : (certificate.recognitionFactor ?? "—")
      });
      this._model.setProperty("/selected", selected);
      this._model.setProperty("/selectedTitle", certificate.certificateNumber || "Certificate review");
      this._model.setProperty("/selectedSubtitle", `Supplier: ${selected.supplierName} · Submitted ${certificate.createdAt ? String(certificate.createdAt).slice(0, 10) : "date unavailable"}`);
      this._model.setProperty("/decisionRemarks", "");
      this._model.setProperty("/documentUrl", "");
      this._model.setProperty("/documentAvailable", false);
      this._model.setProperty("/previewPdf", false);
      this._model.setProperty("/previewImage", false);
      this._model.setProperty("/previewMessageVisible", true);
      this._model.setProperty("/previewMessageType", "Information");
      this._model.setProperty("/previewMessage", "Looking for uploaded evidence…");
      this._model.setProperty("/fileCaption", "Looking for uploaded evidence…");
      this._model.setProperty("/attachmentState", "Information");
      this._model.setProperty("/canApproveCertificate", false);

      try {
        const data = await this._api(`/compliance/Certificates(${certificate.ID})/attachments?$select=ID,filename,mimeType,status,createdAt&$top=1`);
        const attachments = Array.isArray(data?.value) ? data.value : (Array.isArray(data) ? data : []);
        const attachment = attachments[0];
        if (!attachment) {
          this._model.setProperty("/fileCaption", "No uploaded document");
          this._model.setProperty("/attachmentState", "Error");
          this._model.setProperty("/previewMessage", "No attachment was found. The supplier must upload supporting evidence before this certificate can be approved.");
          this._model.setProperty("/previewMessageType", "Warning");
          this._model.setProperty("/canApproveCertificate", false);
        } else if (!UUID_PATTERN.test(attachment.ID || "")) {
          throw new Error("The server returned an invalid attachment ID.");
        } else {
          const contentUrl = `/compliance/Certificates(${certificate.ID})/attachments(ID=${attachment.ID})/content`;
          this._model.setProperty("/fileCaption", `${attachment.filename || "Uploaded evidence"} · ${attachment.mimeType || "unknown type"} · Scan: ${attachment.status || "unknown"}`);
          this._model.setProperty("/attachmentState", this._statusState(attachment.status));

          if (attachment.status !== "Clean") {
            this._model.setProperty("/documentUrl", contentUrl);
            this._model.setProperty("/documentAvailable", true);
            this._model.setProperty("/previewMessage", `The evidence scan status is ${attachment.status || "unknown"}. Approval is disabled until malware scanning reports Clean.`);
            this._model.setProperty("/previewMessageType", "Warning");
            this._model.setProperty("/canApproveCertificate", false);
          } else if (["application/pdf", "image/png", "image/jpeg"].includes(attachment.mimeType)) {
            const response = await fetch(contentUrl, {
              credentials: "same-origin",
              cache: "no-store"
            });

            if (!response.ok) {
              const detail = await response.text().catch(() => "");
              throw new Error(`Evidence content request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
            }

            const responseMimeType = (response.headers.get("content-type") || "")
              .split(";")[0].trim().toLowerCase();

            if (responseMimeType !== String(attachment.mimeType).toLowerCase()) {
              throw new Error(`Evidence type mismatch: expected ${attachment.mimeType}, received ${responseMimeType || "unknown"}.`);
            }

            const sourceBlob = await response.blob();
            if (!sourceBlob.size) {
              throw new Error("The server returned an empty evidence document.");
            }

            this._evidenceObjectUrl = URL.createObjectURL(
              new Blob([sourceBlob], { type: attachment.mimeType })
            );

            this._model.setProperty("/documentUrl", this._evidenceObjectUrl);
            this._model.setProperty("/documentAvailable", true);

            if (attachment.mimeType === "application/pdf") {
              this._model.setProperty("/previewPdf", true);
            } else {
              this._model.setProperty("/previewImage", true);
            }

            this._model.setProperty("/previewMessageVisible", false);
            this._model.setProperty("/canApproveCertificate", true);
          } else {
            this._model.setProperty("/documentUrl", contentUrl);
            this._model.setProperty("/documentAvailable", true);
            this._model.setProperty("/previewMessage", "The attachment is scan-clean, but this file type cannot be previewed here. Open the uploaded document in a new tab to inspect it.");
            this._model.setProperty("/previewMessageType", "Information");
            this._model.setProperty("/canApproveCertificate", true);
          }
        }
      } catch (error) {
        this._model.setProperty("/documentUrl", "");
        this._model.setProperty("/documentAvailable", false);
        this._model.setProperty("/fileCaption", "Evidence metadata unavailable");
        this._model.setProperty("/attachmentState", "Error");
        this._model.setProperty("/previewMessage", error.message);
        this._model.setProperty("/previewMessageType", "Error");
        this._model.setProperty("/previewMessageVisible", true);
        this._model.setProperty("/canApproveCertificate", false);
      }
      this.byId("reviewDialog").open();
    },

    _decideCertificate: async function (action) {
      if (!this._selectedCertificate?.ID) return;
      const remarks = String(this._model.getProperty("/decisionRemarks") || "").trim();
      if (action !== "approveCertificate" && !remarks) {
        this._notify("A reason is required for rejection or a resubmission request.", "Error");
        return;
      }
      if (action === "approveCertificate" && !this._model.getProperty("/canApproveCertificate")) {
        this._notify("Approval is disabled until uploaded evidence has a Clean scan status.", "Error");
        return;
      }
      const labels = {
        approveCertificate: "Certificate approved.",
        rejectCertificate: "Certificate rejected.",
        requestResubmission: "Resubmission requested."
      };
      this.getView().setBusy(true);
      try {
        const result = this._unwrap(await this._api(`/compliance/Certificates(${this._selectedCertificate.ID})/${action}`, {
          method: "POST", body: JSON.stringify({ remarks: remarks || null })
        }));
        this.byId("reviewDialog").close();
        this._selectedCertificate = null;
        this._notify(result?.message || labels[action], "Success");
        await this._loadQueue();
      } catch (error) {
        this._notify(error.message, "Error");
      } finally { this.getView().setBusy(false); }
    },

    onApproveCertificate: function () { this._decideCertificate("approveCertificate"); },
    onRejectCertificate: function () { this._decideCertificate("rejectCertificate"); },
    onRequestResubmission: function () { this._decideCertificate("requestResubmission"); },
    onCloseReview: function () {
      this.byId("reviewDialog").close();
      if (this._evidenceObjectUrl) URL.revokeObjectURL(this._evidenceObjectUrl);
      this._evidenceObjectUrl = null;
      this._model.setProperty("/documentUrl", "");
      this._model.setProperty("/documentAvailable", false);
      this._model.setProperty("/previewPdf", false);
      this._model.setProperty("/previewImage", false);
    },

    onApproveOnboarding: function (event) { this._openOnboardingDecision(event, "approve"); },
    onRejectOnboarding: function (event) { this._openOnboardingDecision(event, "reject"); },

    _openOnboardingDecision: function (event, action) {
      const request = event.getSource().getBindingContext("state").getObject();
      this._selectedRequest = request;
      this._model.setProperty("/selectedRequest", request);
      this._model.setProperty("/onboardingDecision", action);
      this._model.setProperty("/onboardingDialogTitle", action === "approve" ? "Approve supplier onboarding" : "Reject supplier onboarding");
      this._model.setProperty("/onboardingConfirmText", action === "approve" ? "Approve and link" : "Reject request");
      this._model.setProperty("/onboardingRemarksRequired", action === "reject");
      this._model.setProperty("/businessPartnerId", "");
      this._model.setProperty("/onboardingRemarks", action === "approve" ? "Identifiers verified and supplier linked." : "");
      this.byId("onboardingDialog").open();
    },

    onConfirmOnboardingDecision: async function () {
      if (!this._selectedRequest?.ID || !UUID_PATTERN.test(this._selectedRequest.ID)) {
        this._notify("The selected onboarding request ID is invalid.", "Error");
        return;
      }
      const action = this._model.getProperty("/onboardingDecision");
      const businessPartnerId = String(this._model.getProperty("/businessPartnerId") || "").trim();
      const remarks = String(this._model.getProperty("/onboardingRemarks") || "").trim();
      if (action === "reject" && !remarks) {
        this._notify("A rejection reason is required.", "Error");
        return;
      }
      if (action === "approve" && businessPartnerId && !remarks) {
        this._notify("Explain the manual Business Partner selection in the approval remarks.", "Error");
        return;
      }
      const actionName = action === "approve" ? "approveOnboardingRequest" : "rejectOnboardingRequest";
      const payload = action === "approve"
        ? { businessPartnerId: businessPartnerId || null, remarks: remarks || null }
        : { remarks: remarks };
      this.getView().setBusy(true);
      try {
        const result = this._unwrap(await this._api(`/compliance/SupplierOnboardingRequests(${this._selectedRequest.ID})/${actionName}`, {
          method: "POST", body: JSON.stringify(payload)
        }));
        this.byId("onboardingDialog").close();
        this._selectedRequest = null;
        this._notify(result?.message || (action === "approve" ? "Supplier onboarding approved." : "Supplier onboarding rejected."), "Success");
        await this._loadOnboarding();
      } catch (error) {
        this._notify(error.message, "Error");
      } finally { this.getView().setBusy(false); }
    },

    onCloseOnboarding: function () { this.byId("onboardingDialog").close(); }
  });
});
