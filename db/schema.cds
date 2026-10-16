namespace cc.bbbee;

using { cuid, managed } from '@sap/cds/common';
using { Attachments } from '@cap-js/attachments';

// status for submitted cert
type VerificationStatus : String enum {
    Draft;
    PendingReview;
    Approved;
    Rejected;
    Expired;
}

// categories
type EnterpriseType : String enum {
    EME;
    QSE;
    GEN;
}

type CertificateDocumentType : String enum {
    EME_AFFIDAVIT;
    QSE_AFFIDAVIT;
    QSE_SCORECARD;
    GENERIC_SANAS_CERTIFICATE;
}

// this helps distinguishe a supplier with no verified certificate from one that is not compliant
// helps avoid treating a missing B-BBEE assessment as a confirmed non-compliant assessment.

type ComplianceState : String enum {
    Unknown;
    Compliant;
    NonCompliant;
}

type OCRStatus : String enum {
    NotStarted;
    Processing;
    Succeeded;
    Failed;
}


type OnboardingStatus : String enum {
    Pending;
    Matched;
    Rejected;
}

entity Suppliers : cuid, managed {
    @readonly
    businessPartnerId       : String(10);
    identitySubject          : String(255);
    @readonly
    s4SyncStatus             : String(20) not null default 'NotLinked';
    @readonly
    s4LastSyncAt              : Timestamp;
    @readonly
    s4SyncMessage             : String(500);

    companyName             : String(100) not null;
    registrationNumber      : String(20);
    taxNumber               : String(10);
    contactEmail            : String(100);

    @readonly
    currentBEELevel          : Integer;
    @readonly
    currentComplianceState   : ComplianceState
                               not null default #Unknown;
    @readonly
    recognitionFactor        : Decimal(5,2);

    @readonly
    isBlackOwned             : Boolean not null default false;
    @readonly
    isBlackWomenOwned        : Boolean not null default false;

    activeCertificate        : Association to one Certificates;

    certificates             : Composition of many Certificates
                               on certificates.supplier = $self;
}


entity Certificates : cuid, managed {
    supplier                  : Association to one Suppliers
                                not null;

    certificateNumber         : String(50);
    documentType              : CertificateDocumentType;

    extractedEntityName       : String(100);
    extractedRegistrationNumber : String(20);

    sanasAgencyNumber         : String(30);
    enterpriseType            : EnterpriseType;

    @readonly
    status                    : VerificationStatus
                                not null default #Draft;

    @readonly
    ocrStatus       : OCRStatus not null default #NotStarted;

    @readonly
    ocrCompletedAt  : Timestamp;

    @readonly
    ocrError        : String(500);

    beeLevel                  : Integer;
    isNonCompliant            : Boolean not null default false;

    blackOwnership            : Decimal(5,2);
    blackWomenOwnership       : Decimal(5,2);
    empoweringSupplier        : Boolean;

    issueDate                 : Date;
    expiryDate                : Date;
    uploadedAt                : Timestamp;
    @Validation.MaxItems: 1
    attachments : Composition of many Attachments;
documentUrl               : String(500);
    rejectionReason           : String(255);
}


entity AuditTrail : cuid, managed {
    certificate               : Association to one Certificates;
    supplier                  : Association to one Suppliers;
    onboardingRequest         : Association to one SupplierOnboardingRequests;

    action                    : String(50) not null;
    performedBy               : String(100) not null;

    previousStatus            : VerificationStatus;
    newStatus                 : VerificationStatus;

    remarks                   : String(500);
    fieldDeltas               : LargeString;
}



entity SupplierOnboardingRequests : cuid, managed {
    proposedCompanyName : String(100) not null;
    registrationNumber  : String(20);
    taxNumber           : String(10);
    contactEmail        : String(100);
    requestedByIdentity : String(255);
    reviewedBy          : String(100);
    reviewedAt          : Timestamp;
    status              : OnboardingStatus not null default #Pending;
    matchedSupplier     : Association to Suppliers;
    reviewNotes         : String(500);
}




annotate Certificates.attachments with {
    content @Validation.Maximum : '10MB';
    content @Core.AcceptableMediaTypes : [
        'application/pdf',
        'image/png',
        'image/jpeg'
    ];
};

entity IntegrationOutbox : managed {
    key idempotencyKey : String(255);
    eventType          : String(40) not null;
    supplier            : Association to one Suppliers not null;
    certificate         : Association to one Certificates;
    payload             : LargeString;
    status              : String(20) not null default 'Pending';
    attempts            : Integer not null default 0;
    lastAttemptAt       : Timestamp;
    deliveredAt         : Timestamp;
    lastError           : String(1000);
}

// Durable notifications log/outbox. Destination delivery is retried independently.
entity NotificationEvents : managed {
    key idempotencyKey : String(255);
    supplier            : Association to one Suppliers not null;
    certificate         : Association to one Certificates;
    eventType           : String(40) not null;
    daysToExpiry        : Integer;
    recipient           : String(255);
    subject             : String(255) not null;
    body                : LargeString not null;
    status              : String(20) not null default 'Pending';
    attempts            : Integer not null default 0;
    lastAttemptAt       : Timestamp;
    deliveredAt         : Timestamp;
    lastError           : String(1000);
}

// A primary key on the calendar date prevents duplicate daily expiry runs across app instances.
entity ExpiryJobRuns : managed {
    key runDate         : Date;
    status              : String(20) not null default 'Running';
    certificatesExpired : Integer not null default 0;
    notificationsQueued : Integer not null default 0;
    integrationQueued   : Integer not null default 0;
    startedAt           : Timestamp;
    runToken            : String(36);
    finishedAt          : Timestamp;
    errorMessage        : String(1000);
}

// Explicit simulation of the external S/4HANA Business Partner master for demos.
// This data is local to this CAP application and is NOT a real SAP ERP system.
// It is only used when S4_BACKEND_MODE=mock.
entity MockBusinessPartners : managed {
    key businessPartnerId  : String(10);
    companyName             : String(100) not null;
    taxNumber               : String(10);
    registrationNumber      : String(20);
    beeLevel                : Integer;
    recognitionFactor       : Decimal(5,2);
    certificateExpiry       : Date;
    enterpriseType          : String(3);
    complianceStatus        : String(20) not null default 'Unknown';
    blackOwnership          : Decimal(5,2);
    blackWomenOwnership    : Decimal(5,2);
    lastSyncAt              : Timestamp;
    lastIdempotencyKey      : String(255);
    lastSyncPayload         : LargeString;
}
