using ComplianceService as service from '../../srv/service';

annotate service.Certificates with @(
    Common.Label: 'B-BBEE Certificate',

    UI.HeaderInfo: {
        TypeName: 'B-BBEE Certificate',
        TypeNamePlural: 'B-BBEE Certificates',
        Title: {
            $Type: 'UI.DataField',
            Value: certificateNumber
        },
        Description: {
            $Type: 'UI.DataField',
            Value: extractedEntityName
        }
    },

    UI.SelectionFields: [
        status,
        enterpriseType,
        beeLevel,
        ocrStatus,
        expiryDate
    ],

    UI.LineItem: [
        {
            $Type: 'UI.DataField',
            Label: 'Certificate Number',
            Value: certificateNumber
        },
        {
            $Type: 'UI.DataField',
            Label: 'Document Type',
            Value: documentType
        },
        {
            $Type: 'UI.DataField',
            Label: 'Supplier / Entity',
            Value: extractedEntityName
        },
        {
            $Type: 'UI.DataField',
            Label: 'Registration Number',
            Value: extractedRegistrationNumber
        },
        {
            $Type: 'UI.DataField',
            Label: 'Verification Status',
            Value: status
        },
        {
            $Type: 'UI.DataField',
            Label: 'OCR Status',
            Value: ocrStatus
        },
        {
            $Type: 'UI.DataField',
            Label: 'Enterprise Type',
            Value: enterpriseType
        },
        {
            $Type: 'UI.DataField',
            Label: 'B-BBEE Level',
            Value: beeLevel
        },
        {
            $Type: 'UI.DataField',
            Label: 'Black Ownership (%)',
            Value: blackOwnership
        },
        {
            $Type: 'UI.DataField',
            Label: 'Expiry Date',
            Value: expiryDate
        }
    ],

    UI.Facets: [
        {
            $Type: 'UI.ReferenceFacet',
            ID: 'CertificateDetails',
            Label: 'Certificate Details',
            Target: '@UI.FieldGroup#CertificateDetails'
        },
        {
            $Type: 'UI.ReferenceFacet',
            ID: 'BEEAssessment',
            Label: 'B-BBEE Assessment',
            Target: '@UI.FieldGroup#BEEAssessment'
        },
        {
            $Type: 'UI.ReferenceFacet',
            ID: 'OCRInformation',
            Label: 'Document Extraction',
            Target: '@UI.FieldGroup#OCRInformation'
        },
        {
            $Type: 'UI.ReferenceFacet',
            ID: 'UploadedDocuments',
            Label: 'Uploaded Documents',
            Target: 'attachments/@UI.LineItem'
        }
    ],

    UI.FieldGroup #CertificateDetails: {
        $Type: 'UI.FieldGroupType',
        Data: [
            {
                $Type: 'UI.DataField',
                Label: 'Certificate Number',
                Value: certificateNumber
            },
            {
                $Type: 'UI.DataField',
                Label: 'Supplier Entity Name',
                Value: extractedEntityName
            },
            {
                $Type: 'UI.DataField',
                Label: 'Registration Number',
                Value: extractedRegistrationNumber
            },
            {
                $Type: 'UI.DataField',
                Label: 'SANAS Agency Number',
                Value: sanasAgencyNumber
            },
            {
                $Type: 'UI.DataField',
                Label: 'Enterprise Type',
                Value: enterpriseType
            },
            {
                $Type: 'UI.DataField',
                Label: 'Issue Date',
                Value: issueDate
            },
            {
                $Type: 'UI.DataField',
                Label: 'Expiry Date',
                Value: expiryDate
            },
            {
                $Type: 'UI.DataField',
                Label: 'Verification Status',
                Value: status
            },
            {
                $Type: 'UI.DataField',
                Label: 'Rejection / Resubmission Notes',
                Value: rejectionReason
            }
        ]
    },

    UI.FieldGroup #BEEAssessment: {
        $Type: 'UI.FieldGroupType',
        Data: [
            {
                $Type: 'UI.DataField',
                Label: 'B-BBEE Level',
                Value: beeLevel
            },
            {
                $Type: 'UI.DataField',
                Label: 'Non-Compliant',
                Value: isNonCompliant
            },
            {
                $Type: 'UI.DataField',
                Label: 'Black Ownership (%)',
                Value: blackOwnership
            },
            {
                $Type: 'UI.DataField',
                Label: 'Black Women Ownership (%)',
                Value: blackWomenOwnership
            },
            {
                $Type: 'UI.DataField',
                Label: 'Empowering Supplier',
                Value: empoweringSupplier
            }
        ]
    },

    UI.FieldGroup #OCRInformation: {
        $Type: 'UI.FieldGroupType',
        Data: [
            {
                $Type: 'UI.DataField',
                Label: 'OCR Status',
                Value: ocrStatus
            },
            {
                $Type: 'UI.DataField',
                Label: 'OCR Completed At',
                Value: ocrCompletedAt
            },
            {
                $Type: 'UI.DataField',
                Label: 'OCR Error',
                Value: ocrError
            }
        ]
    }
);

annotate service.Certificates with {
    supplier @Common.ValueList: {
        $Type: 'Common.ValueListType',
        CollectionPath: 'Suppliers',
        Parameters: [
            {
                $Type: 'Common.ValueListParameterInOut',
                LocalDataProperty: supplier_ID,
                ValueListProperty: 'ID'
            },
            {
                $Type: 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'companyName'
            },
            {
                $Type: 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'registrationNumber'
            },
            {
                $Type: 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'businessPartnerId'
            }
        ]
    }
};

annotate service.Certificates.attachments with @(
    UI.LineItem: [
        {
            $Type: 'UI.DataField',
            Label: 'File Name',
            Value: filename
        },
        {
            $Type: 'UI.DataField',
            Label: 'Media Type',
            Value: mimeType
        },
        {
            $Type: 'UI.DataField',
            Label: 'Scan Status',
            Value: status
        },
        {
            $Type: 'UI.DataField',
            Label: 'Uploaded At',
            Value: createdAt
        }
    ]
);


/*
 * Compliance officer actions on the certificate Object Page.
 * The actions are bound to the selected certificate.
 */
annotate service.Certificates with @UI.Identification: [
    {
        $Type: 'UI.DataFieldForAction',
        Label: 'Submit for Review',
        Action: 'ComplianceService.submitForReview',
        InvocationGrouping: #Isolated
    },
    {
        $Type: 'UI.DataFieldForAction',
        Label: 'Approve Certificate',
        Action: 'ComplianceService.approveCertificate',
        InvocationGrouping: #Isolated
    },
    {
        $Type: 'UI.DataFieldForAction',
        Label: 'Reject Certificate',
        Action: 'ComplianceService.rejectCertificate',
        InvocationGrouping: #Isolated
    },
    {
        $Type: 'UI.DataFieldForAction',
        Label: 'Request Resubmission',
        Action: 'ComplianceService.requestResubmission',
        InvocationGrouping: #Isolated
    }
];

/* Supplier identity and synchronization state visible on the compliance supplier entity. */
annotate service.Suppliers with @(
    UI.HeaderInfo: {
        TypeName: 'Supplier',
        TypeNamePlural: 'Suppliers',
        Title: { $Type: 'UI.DataField', Value: companyName },
        Description: { $Type: 'UI.DataField', Value: businessPartnerId }
    },
    UI.LineItem: [
        { $Type: 'UI.DataField', Label: 'Company', Value: companyName },
        { $Type: 'UI.DataField', Label: 'CIPC Registration', Value: registrationNumber },
        { $Type: 'UI.DataField', Label: 'S/4HANA BP', Value: businessPartnerId },
        { $Type: 'UI.DataField', Label: 'Compliance State', Value: currentComplianceState },
        { $Type: 'UI.DataField', Label: 'B-BBEE Level', Value: currentBEELevel },
        { $Type: 'UI.DataField', Label: 'Recognition Factor', Value: recognitionFactor },
        { $Type: 'UI.DataField', Label: 'S/4 Sync Status', Value: s4SyncStatus },
        { $Type: 'UI.DataField', Label: 'Last S/4 Sync', Value: s4LastSyncAt },
        { $Type: 'UI.DataField', Label: 'Sync Detail', Value: s4SyncMessage }
    ]
);

/* This entity also has a dedicated onboarding.html page so administrators can
   approve/reject staged requests and explicitly supply a confirmed BP number. */
annotate service.SupplierOnboardingRequests with @(
    Common.Label: 'Supplier Onboarding Request',
    UI.HeaderInfo: {
        TypeName: 'Onboarding Request',
        TypeNamePlural: 'Onboarding Requests',
        Title: { $Type: 'UI.DataField', Value: proposedCompanyName },
        Description: { $Type: 'UI.DataField', Value: status }
    },
    UI.SelectionFields: [status, taxNumber, registrationNumber],
    UI.LineItem: [
        { $Type: 'UI.DataField', Label: 'Proposed Company', Value: proposedCompanyName },
        { $Type: 'UI.DataField', Label: 'Tax Number', Value: taxNumber },
        { $Type: 'UI.DataField', Label: 'CIPC Registration', Value: registrationNumber },
        { $Type: 'UI.DataField', Label: 'Contact Email', Value: contactEmail },
        { $Type: 'UI.DataField', Label: 'Status', Value: status },
        { $Type: 'UI.DataField', Label: 'Submitted', Value: createdAt },
        { $Type: 'UI.DataField', Label: 'Review Notes', Value: reviewNotes },
        { $Type: 'UI.DataFieldForAction', Label: 'Approve / Link Business Partner', Action: 'ComplianceService.approveOnboardingRequest', InvocationGrouping: #Isolated },
        { $Type: 'UI.DataFieldForAction', Label: 'Reject Request', Action: 'ComplianceService.rejectOnboardingRequest', InvocationGrouping: #Isolated }
    ],
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'ProposedSupplier', Label: 'Proposed Supplier', Target: '@UI.FieldGroup#ProposedSupplier' }
    ]
);

annotate service.SupplierOnboardingRequests with @UI.FieldGroup #ProposedSupplier: {
    $Type: 'UI.FieldGroupType',
    Data: [
        { $Type: 'UI.DataField', Label: 'Company Name', Value: proposedCompanyName },
        { $Type: 'UI.DataField', Label: 'Tax Number', Value: taxNumber },
        { $Type: 'UI.DataField', Label: 'Registration Number', Value: registrationNumber },
        { $Type: 'UI.DataField', Label: 'Contact Email', Value: contactEmail },
        { $Type: 'UI.DataField', Label: 'Status', Value: status },
        { $Type: 'UI.DataField', Label: 'Review Notes', Value: reviewNotes }
    ]
};
