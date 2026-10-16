# B-BBEE Vendor Portal

SAP CAP Node.js application for supplier B-BBEE certificate onboarding, Azure Document Intelligence extraction, compliance review, auditable approval workflow, and queued S/4HANA compliance write-back.

## Apps

- `app/supplier-portal` — supplier-facing registration, certificate draft/upload, OCR correction and submission UI.
- `app/compliance-review` — compliance officer Fiori Elements review application and administrator onboarding queue.
- `srv/` — CAP service handlers for supplier matching, certificate workflow, OCR, authorization and scheduled expiry/integration/notification workers.
- `db/` — CAP data model including certificates, audit records, staging, integration outbox and notification outbox.

## Local development

```bash
npm ci
cp .env.example .env
# Edit .env with an Azure Document Intelligence endpoint and key if testing OCR.
npm start
```

CAP starts locally with SQLite and mock authentication according to the project development profile. Run the supplier portal in a second terminal so its local proxy can route API calls to CAP:

```bash
cd app/supplier-portal
npm install
npm start
```

Open the Fiori Elements compliance application with:

```bash
npm run watch-compliance-review
```

Azure credentials are never stored in the repository. The supplied `.env.example` contains placeholders only.

## Tests and build

```bash
npm test
npx cds build --production
```

For MTA packaging, run the standard MTA build after the CAP build dependencies are installed. The MTA contains both HTML5 applications, a CAP service, HDI deployer, approuter and required BTP managed service bindings.

## Live integrations

The application defaults to a **local mock Business Partner registry** (`S4_BACKEND_MODE=mock`, `S4_SYNC_MODE=mock`) so you can demonstrate matching, approvals, expiry and compliance write-back without owning an S/4HANA system. The simulated BPs are local demo records, not SAP tenant data. Use SAP Business Accelerator Hub to inspect and try the official API contract if useful, but do not depend on Hub sandbox data for persistent application write-back. Only set `S4_BACKEND_MODE=destination` and `S4_SYNC_MODE=live` if a real S/4HANA tenant and verified B-BBEE extension fields become available. `BEE_NOTIFICATION_MODE=log` records notifications but does not send email. Review `IMPLEMENTATION_NOTES.md` for the demo and deployment configuration.


For BTP demo deployment, the service module in `mta.yaml` defaults to `S4_BACKEND_MODE=mock`, `S4_SYNC_MODE=mock`, and `BEE_NOTIFICATION_MODE=log`. You do not need an S/4HANA destination or SAP Business Accelerator Hub key for the app to simulate Business Partner matching and compliance updates. You still need the Azure OCR destination if you want live OCR in the deployed environment.
