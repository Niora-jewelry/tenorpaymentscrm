/** The 5 locked rows every record's Application Files subtab has —
 * "defined as a system structure," per the prototype's own framing, not
 * something a user adds or removes. No server code: the list reads them too. */
export const APPLICATION_ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'] as const;
