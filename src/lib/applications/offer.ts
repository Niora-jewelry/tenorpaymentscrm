/**
 * Whether merchants are offered the PDF of the application.
 *
 * Hidden, not removed (client, 6 Nov 2026: "Remove the pdf version of the
 * application for now (we will bring it back at a later date so do not delete
 * it, just hide it)"). While this is false the application email carries only
 * the online link, the merchant's page opens straight on the online form, and
 * Preview shows the online form.
 *
 * Staff can still upload a PDF a merchant returns: applications sent before this
 * change went out with one attached. Setting this to true brings all of it back.
 */
export const PDF_APPLICATION_OFFERED: boolean = false;
