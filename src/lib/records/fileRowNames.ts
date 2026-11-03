/** The locked rows every record's Files tab has — "defined as a system
 * structure," per the prototype's own framing, not something a user adds or
 * removes. No server code: the list reads them too. Agreement joined them with
 * the Field-Tab Review (3 Nov 2026), when the Agreements tab moved into Files. */
export const APPLICATION_ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check', 'Agreement'] as const;
