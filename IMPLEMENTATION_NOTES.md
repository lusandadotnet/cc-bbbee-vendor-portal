# B-BBEE Vendor Portal — implementation notes

## Delivered in this source tree

- Supplier-facing portal for supplier identification, onboarding staging, certificate drafts, PDF/PNG/JPEG uploads, scan-status checks, Azure OCR, correction of extracted fields, saving and submitting a certificate for review.
- Compliance reviewer workbench with evidence preview and approval, rejection and resubmission actions; the backend requires a malware-scan-clean PDF/PNG/JPEG before submission or approval and records transaction-backed audit deltas. Approved/in-review certificates cannot be edited directly.
- S/4HANA Business Partner matching through the `API_BUSINESS_PARTNER` OData API; unresolved or ambiguous matches go to onboarding staging instead of receiving a fabricated BP number.
- Administrator onboarding approval/rejection, including verification that a manually entered BP exists in S/4HANA and an audit rationale for a manual link.
- Transactional S/4 integration outbox, stable idempotency keys, retry/backoff handling, supplier-visible sync status and a dry-run default.
- Daily expiry sweep in the Africa/Johannesburg timezone, idempotent 60/30/7-day notification events, expiry audit, local compliance state change to `NonCompliant` and recognition factor `0`, and queued S/4 write-back.
- Durable notification outbox with retry and blocked-recipient handling; a Destination Service endpoint is used for live delivery.
- Supplier-scoped read filtering and backend role checks for supplier, compliance and system-admin operations. Local development can use CAP mocked authentication; the role checks are not switched off simply because `NODE_ENV` is missing in Cloud Foundry.
- HANA/HDI, XSUAA, Destination Service, Object Store, HTML5 app host/runtime and approuter deployment wiring.

## Important external configuration required before live use

The repository cannot provision or infer your tenant's actual S/4HANA custom fields, destination URLs, role-collection assignments, Azure credentials, notification delivery provider, or HANA Cloud instance.

1. **S/4HANA destination.** Create the HTTPS destination named `S4HANA_BUSINESS_PARTNER`, with connectivity/authentication appropriate for your tenant and access to the released `API_BUSINESS_PARTNER` API. The integration currently defaults to `S4_SYNC_MODE=dry-run`; keep it there until the custom field mappings below have been confirmed in your target system.
2. **S/4HANA B-BBEE extension fields.** The target API needs fields for B-BBEE level, recognition factor, certificate expiry, enterprise type and compliance status. Set `S4_FIELD_BBEE_LEVEL`, `S4_FIELD_RECOGNITION_FACTOR`, `S4_FIELD_CERTIFICATE_EXPIRY`, `S4_FIELD_ENTERPRISE_TYPE` and `S4_FIELD_COMPLIANCE_STATUS` to the real API property names of those deployed extensions. The `YY1_*` names in `.env.example` are illustrative placeholders, not claims that those fields exist in your tenant. Ownership fields are optional and require actual extension fields too.
3. **No global BP blocking.** This code deliberately does not set standard `BusinessPartnerIsBlocked`, because that can impact unrelated procurement/payment processes. It writes B-BBEE compliance state into the specifically mapped custom extension field and sets the recognition factor to zero on expiry.
4. **Azure Document Intelligence.** In local development, configure `bbbee.azure.endpoint` and `bbbee.azure.key` in your untracked `.env` file. For BTP, create the `AZURE_DOCUMENT_INTELLIGENCE` HTTPS destination with the required subscription-key/header configuration, or adapt the tenant's destination policy to the Azure resource. Never commit the key.
5. **Notification provider.** Create the HTTPS Destination `BB_BEE_NOTIFICATION_SERVICE` to an approved adapter/API that accepts `POST /notifications` (or configure `BEE_NOTIFICATION_PATH`). The adapter must deliver the supplied `to`, `subject`, and `body`, and should honour the `Idempotency-Key` header. Destination Service itself is routing/configuration; it is not an email delivery system. Set `BEE_NOTIFICATION_MODE=destination` for actual delivery. The default local `log` mode records events but does not send email.
6. **Identity and access.** Deploy the XSUAA descriptor, connect the required IAS trust configuration in the BTP subaccount, and assign the `BEE_Supplier_User`, `BEE_Compliance_Officer`, and `BEE_System_Admin` role templates to intended users/role collections. Verify each route with least-privilege real tenant users.
7. **HANA/entitlements.** A HANA Cloud instance must exist and the subaccount must be entitled for HDI/HANA, XSUAA, Destination, HTML5 Apps Repository and Object Store. The MTA provisions the HDI container and application bindings; it does not create a HANA Cloud database instance or configure your tenant's S/4 endpoints/custom fields for you.

## Configuration reference

Copy `.env.example` to `.env` for local testing and replace placeholders only with your real settings. `.env` is ignored by Git. For production, use platform-managed destination/service credentials and environment properties, not committed secrets.

## Validation performed in the implementation workspace

- JavaScript syntax checks completed for files under `srv/` and `app/`.
- `npm test`: 16 passing tests (11 B-BBEE rule tests and 5 expiry-reminder boundary tests). The test script explicitly targets `tests/*.test.js`, so UI5-generated browser journey files are not mistakenly run as Node tests.
- `npm ci --dry-run`: workspace lockfile consistency verified after adding the supplier portal workspace.

A full CAP CDS/HANA build and deployed S/4/Azure/notification integration could not be executed in this isolated workspace. The actual dependency installation was blocked by `EAI_AGAIN registry.npmjs.org` (DNS/network failure), so I did not claim a `cds build --production` result. No live BTP/S/4 tenant credentials are included in the archive. Do not treat production deployment as complete until the remaining tenant-specific configuration and integration verification are done.
