sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"za/co/bbbee/compliancereview/test/integration/pages/CertificatesList.gen",
	"za/co/bbbee/compliancereview/test/integration/pages/CertificatesObjectPage.gen"
], function (JourneyRunner, CertificatesListGenerated, CertificatesObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('za/co/bbbee/compliancereview') + '/test/flp.html#app-preview',
        pages: {
			onTheCertificatesListGenerated: CertificatesListGenerated,
			onTheCertificatesObjectPageGenerated: CertificatesObjectPageGenerated
        },
        async: true
    });

    return runner;
});

