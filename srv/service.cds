using { cc.bbbee as db } from '../db/schema';

type SupplierMatchResult {
    matched             : Boolean;
    requiresOnboarding   : Boolean;
    source               : String(40);
    supplierID           : UUID;
    businessPartnerId    : String(10);
    companyName          : String(100);
    onboardingRequestID  : UUID;
    message               : String(500);
}

type OnboardingWorkflowResult {
    requestID          : UUID;
    supplierID         : UUID;
    businessPartnerId  : String(10);
    status             : String(30);
    message            : String(500);
}

type SupplierCertificateWorkflowResult {
    certificateID     : UUID;
    supplierID        : UUID;
    status            : String(30);
    recognitionFactor : Decimal(5,2);
    auditID           : UUID;
    message            : String(500);
}

type AutomationResult {
    status               : String(30);
    message              : String(500);
    certificatesExpired  : Integer;
    notificationsQueued  : Integer;
    integrationQueued    : Integer;
    integrationProcessed : Integer;
}

@path: '/supplier'
@impl: 'srv/supplier-service.js'
service SupplierService {
    entity Suppliers as projection on db.Suppliers {
        ID, createdAt, modifiedAt, companyName, registrationNumber, taxNumber,
        contactEmail, businessPartnerId, currentBEELevel, currentComplianceState, recognitionFactor,
        isBlackOwned, isBlackWomenOwned, activeCertificate, certificates
    };
    entity Certificates as projection on db.Certificates actions {
        action submitForReview() returns SupplierCertificateWorkflowResult;
    };
    @readonly
    entity SupplierOnboardingRequests as projection on db.SupplierOnboardingRequests {
        ID, createdAt, modifiedAt, proposedCompanyName, registrationNumber,
        taxNumber, contactEmail, status, matchedSupplier, reviewNotes
    };

    action matchSupplier(
        companyName        : String(100) not null,
        taxNumber          : String(10),
        registrationNumber : String(20),
        contactEmail       : String(100)
    ) returns SupplierMatchResult;

    action approveOnboardingRequest(
        requestID        : UUID not null,
        businessPartnerId : String(10),
        remarks           : String(500)
    ) returns OnboardingWorkflowResult;

    action rejectOnboardingRequest(
        requestID : UUID not null,
        remarks   : String(500) not null
    ) returns OnboardingWorkflowResult;
}

@path: '/compliance'
@impl: 'srv/compliance-service.js'
service ComplianceService {
    type CertificateWorkflowResult {
        certificateID     : UUID;
        supplierID        : UUID;
        status            : String(30);
        recognitionFactor : Decimal(5,2);
        auditID           : UUID;
        message           : String(500);
    }

    entity Suppliers as projection on db.Suppliers {
        ID, createdAt, modifiedAt, companyName, registrationNumber, taxNumber,
        contactEmail, businessPartnerId, s4SyncStatus, s4LastSyncAt, s4SyncMessage,
        currentBEELevel, currentComplianceState, recognitionFactor,
        isBlackOwned, isBlackWomenOwned, activeCertificate, certificates
    };
    entity Certificates as projection on db.Certificates actions {
        action submitForReview() returns CertificateWorkflowResult;
        action approveCertificate(remarks: String(500)) returns CertificateWorkflowResult;
        action rejectCertificate(remarks: String(500) not null) returns CertificateWorkflowResult;
        action requestResubmission(remarks: String(500) not null) returns CertificateWorkflowResult;
    };

    @readonly
    entity AuditTrail as projection on db.AuditTrail;
    @readonly
    entity SupplierOnboardingRequests as projection on db.SupplierOnboardingRequests {
        ID, createdAt, modifiedAt, proposedCompanyName, registrationNumber,
        taxNumber, contactEmail, reviewedBy, reviewedAt,
        status, matchedSupplier, reviewNotes
    } actions {
        action approveOnboardingRequest(businessPartnerId: String(10), remarks: String(500)) returns OnboardingWorkflowResult;
        action rejectOnboardingRequest(remarks: String(500) not null) returns OnboardingWorkflowResult;
    };
    @readonly
    entity IntegrationOutbox as projection on db.IntegrationOutbox;
    @readonly
    entity NotificationEvents as projection on db.NotificationEvents;
    @readonly
    entity ExpiryJobRuns as projection on db.ExpiryJobRuns;

    // demo only view into erp state
    @readonly
    entity MockBusinessPartners as projection on db.MockBusinessPartners;

    type CertificateOCRResult {
        certificateID               : UUID;
        ocrStatus                   : String(20);
        message                     : String(500);
        extractedEntityName         : String(100);
        extractedRegistrationNumber : String(20);
        certificateNumber           : String(50);
        sanasAgencyNumber           : String(30);
        enterpriseType              : db.EnterpriseType;
        beeLevel                    : Integer;
        isNonCompliant              : Boolean;
        recognitionFactor           : Decimal(5,2);
        blackOwnership              : Decimal(5,2);
        blackWomenOwnership         : Decimal(5,2);
        empoweringSupplier          : Boolean;
        issueDate                   : Date;
        expiryDate                  : Date;
    }

    action analyzeCertificate(
        certificateID : UUID not null,
        attachmentID  : UUID not null
    ) returns CertificateOCRResult;

    action runDailyExpiryJob() returns AutomationResult;
    action processIntegrationOutbox() returns AutomationResult;
    action dispatchNotifications() returns AutomationResult;
    action requeueBlockedNotifications() returns AutomationResult;
}
