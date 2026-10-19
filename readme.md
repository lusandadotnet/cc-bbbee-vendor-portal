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
