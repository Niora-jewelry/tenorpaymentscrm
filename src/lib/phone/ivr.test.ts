import { describe, expect, it } from 'vitest';
import {
  SALES_QUEUE,
  SUPPORT_FORWARD_E164,
  agentTwiml,
  discoverTwiml,
  enqueueTwiml,
  extensionTwiml,
  greetingTwiml,
  holdTwiml,
  interpretDigits,
  invalidTwiml,
  noTargetsTwiml,
  supportTransferTwiml,
  voicemailTwiml,
  type IvrConfig,
  type IvrTarget,
} from './ivr';

/**
 * Every path through both of the client's documents, as ordinary tests.
 *
 * The point of building the menu as pure functions: these branches are
 * otherwise reachable only by telephoning the number and pressing keys, one
 * branch per call, and some of them — no extensions configured, the third
 * minute on hold, an invalid key after hours — are awkward or impossible to
 * reach deliberately.
 */
const cfg: IvrConfig = {
  voice: 'Polly.Joanna-Neural',
  language: 'en-US',
  holdMusicUrl: 'https://example.com/hold.mp3',
  recordNotice: true,
  ringSeconds: 60,
  voicemailMaxSeconds: 180,
  origin: 'https://crm.example.com',
  prompts: {
    greeting_open: 'GREETING OPEN',
    greeting_closed: 'GREETING CLOSED',
    transfer_open: 'TRANSFER OPEN',
    transfer_closed: 'TRANSFER CLOSED',
    high_volume: 'HIGH VOLUME',
    voicemail_prompt: 'LEAVE A MESSAGE',
    voicemail_closed: 'CLOSED VOICEMAIL',
    support_transfer: 'SUPPORT TRANSFER',
    discover: 'DISCOVER',
    invalid_entry: 'INVALID ENTRY',
    record_notice: 'RECORDED NOTICE',
  },
};

const ext = (digits: string | null, over: Partial<IvrTarget> = {}): IvrTarget => ({
  label: 'Someone',
  userId: null,
  externalE164: '+15550001111',
  digits,
  ...over,
});

describe('interpretDigits', () => {
  it('nothing pressed is its own case, not an invalid entry', () => {
    expect(interpretDigits('', []).kind).toBe('none');
    expect(interpretDigits(null, []).kind).toBe('none');
  });

  it('1, 2 and 3 are the menu', () => {
    for (const d of ['1', '2', '3']) {
      expect(interpretDigits(d, [])).toEqual({ kind: 'menu', digit: d });
    }
  });

  it('a configured extension is recognised', () => {
    expect(interpretDigits('101', [ext('101')])).toEqual({ kind: 'extension', digits: '101' });
  });

  it('an unconfigured number is an invalid entry', () => {
    expect(interpretDigits('999', [ext('101')])).toEqual({ kind: 'invalid', digits: '999' });
  });

  /*
   * The menu must survive a misconfiguration. If someone gives a person
   * extension "1", the greeting's own instructions would otherwise stop
   * working for every caller.
   */
  it('the menu wins over an extension that would shadow it', () => {
    expect(interpretDigits('1', [ext('1')])).toEqual({ kind: 'menu', digit: '1' });
  });

  it('ignores punctuation Twilio may include', () => {
    expect(interpretDigits('1#', [])).toEqual({ kind: 'menu', digit: '1' });
  });
});

describe('the greeting', () => {
  it('reads the open greeting and collects digits', () => {
    const x = greetingTwiml(cfg, { open: true });
    expect(x).toContain('GREETING OPEN');
    expect(x).toContain('<Gather');
    expect(x).toContain('/api/twilio/ivr/menu');
  });

  it('reads the closed greeting after hours', () => {
    expect(greetingTwiml(cfg, { open: false })).toContain('GREETING CLOSED');
  });

  /*
   * The greeting promises "you may dial your party's extension at any time"
   * AND "press 1". A numDigits of 1 could never collect 101; a numDigits of 3
   * would hang after "1". So there must be no numDigits at all.
   */
  it('does not fix the number of digits, so extensions remain dialable', () => {
    expect(greetingTwiml(cfg, { open: true })).not.toContain('numDigits');
  });

  it('announces that the call may be recorded when that is switched on', () => {
    expect(greetingTwiml(cfg, { open: true })).toContain('RECORDED NOTICE');
    expect(greetingTwiml({ ...cfg, recordNotice: false }, { open: true })).not.toContain(
      'RECORDED NOTICE',
    );
  });

  /*
   * During Hours: "For all other inquiries, please stay on the line, and one of
   * our representatives will be with you shortly." Silence has to reach the
   * same place as pressing 1.
   */
  it('open hours: saying nothing behaves like pressing 1', () => {
    const x = greetingTwiml(cfg, { open: true });
    expect(x).toContain('<Redirect');
    expect(x).toContain('Digits=1');
  });

  it('closed hours: saying nothing does not transfer anyone', () => {
    const x = greetingTwiml(cfg, { open: false });
    expect(x).toContain('<Redirect');
    expect(x).not.toContain('Digits=1');
  });
});

describe('option 2 — merchant support', () => {
  it('reads the message and forwards to the published number', () => {
    const x = supportTransferTwiml(cfg);
    expect(x).toContain('SUPPORT TRANSFER');
    expect(x).toContain(SUPPORT_FORWARD_E164);
  });

  /*
   * Q12: confirmed that the call leaves TapDash for good. An `action` would
   * bring it back here after the far end hung up, which is precisely what was
   * confirmed NOT to want.
   */
  it('does not come back to us afterwards', () => {
    const x = supportTransferTwiml(cfg);
    expect(x).not.toContain('action=');
    expect(x).toContain('<Hangup/>');
  });
});

describe('option 3 — the Discover settlement', () => {
  it('reads the settlement message', () => {
    expect(discoverTwiml(cfg)).toContain('DISCOVER');
  });

  it('waits thirty seconds, then transfers as though 1 had been pressed', () => {
    const x = discoverTwiml(cfg);
    expect(x).toContain('timeout="30"');
    expect(x).toContain('Digits=1');
  });
});

describe('the hold queue', () => {
  it('says the transfer line and enqueues, rather than dialling', () => {
    const x = enqueueTwiml(cfg, { closed: false });
    expect(x).toContain('TRANSFER OPEN');
    expect(x).toContain('<Enqueue');
    expect(x).toContain(SALES_QUEUE);
  });

  it('uses the closed wording after hours', () => {
    expect(enqueueTwiml(cfg, { closed: true })).toContain('TRANSFER CLOSED');
  });

  /*
   * Both documents: "There should then be hold music until someone answers."
   * A <Dial> plays a ringback tone and cannot play music, which is the whole
   * reason the caller is queued instead.
   */
  it('plays music while waiting', () => {
    expect(holdTwiml(cfg, { loop: 0, closed: false })).toContain(cfg.holdMusicUrl);
  });

  it('the first minute is music only — nobody is told about call volume early', () => {
    const x = holdTwiml(cfg, { loop: 0, closed: false });
    expect(x).not.toContain('HIGH VOLUME');
    expect(x).toContain('loop=1');
  });

  it('after a minute it offers voicemail', () => {
    const x = holdTwiml(cfg, { loop: 1, closed: false });
    expect(x).toContain('HIGH VOLUME');
    expect(x).toContain('<Gather');
    expect(x).toContain('/api/twilio/ivr/hold-choice');
  });

  /*
   * During Hours: "This should continue every minute until someone answers."
   * So the open loop must never terminate by itself.
   */
  it('open hours: the loop repeats indefinitely', () => {
    const x = holdTwiml(cfg, { loop: 5, closed: false });
    expect(x).toContain('HIGH VOLUME');
    expect(x).toContain('loop=6');
    expect(x).not.toContain('<Leave/>');
  });

  /*
   * After Hours is different, and the difference is easy to miss: there is no
   * "remain on the line" option at all. One minute, then voicemail.
   */
  it('closed hours: one minute, then voicemail — no endless hold', () => {
    const x = holdTwiml(cfg, { loop: 1, closed: true });
    expect(x).toContain('CLOSED VOICEMAIL');
    expect(x).toContain('<Leave/>');
    expect(x).not.toContain('HIGH VOLUME');
  });

  it('an answering agent is bridged to the waiting caller', () => {
    const x = agentTwiml(cfg);
    expect(x).toContain('<Queue>');
    expect(x).toContain(SALES_QUEUE);
    expect(x).toContain('record-from-answer-dual');
  });
});

describe('voicemail', () => {
  it('records, with a beep and a cap', () => {
    const x = voicemailTwiml(cfg, {});
    expect(x).toContain('LEAVE A MESSAGE');
    expect(x).toContain('<Record');
    expect(x).toContain(`maxLength="${cfg.voicemailMaxSeconds}"`);
    expect(x).toContain('playBeep="true"');
  });

  it('uses the after-hours wording when closed', () => {
    expect(voicemailTwiml(cfg, { closed: true })).toContain('CLOSED VOICEMAIL');
  });

  /*
   * An action-less <Record> re-requests the entry document when it finishes,
   * which inserts a SECOND call row. That was the worst bug in the phone
   * module before this; it must not come back.
   */
  it('is always terminal', () => {
    const x = voicemailTwiml(cfg, { callId: 'abc' });
    expect(x).toContain('action=');
    expect(x).toContain('phase=voicemail-end');
    expect(x).toContain('<Hangup/>');
  });

  it('carries the call id so the recording can be correlated', () => {
    expect(voicemailTwiml(cfg, { callId: 'abc-123' })).toContain('callId=abc-123');
  });

  it('can skip its own announcement when one has just been read', () => {
    expect(voicemailTwiml(cfg, { announce: false })).not.toContain('LEAVE A MESSAGE');
  });
});

describe('dead ends', () => {
  it('an invalid entry is said aloud and the menu starts again', () => {
    const x = invalidTwiml(cfg, { open: true });
    expect(x).toContain('INVALID ENTRY');
    expect(x).toContain('/api/twilio/ivr/entry');
  });

  /*
   * The state the system is genuinely in today: "WE WILL ADD EXTENSIONS
   * AFTER". A menu that answers and then goes silent is worse than no menu.
   */
  it('with nobody configured to ring, the caller still reaches voicemail', () => {
    const x = noTargetsTwiml(cfg, { closed: false });
    expect(x).toContain('<Record');
    expect(x).not.toContain('<Hangup/><Response>');
  });

  it('a direct extension falls back to voicemail rather than silence', () => {
    const x = extensionTwiml(cfg, { target: ext('101', { userId: 'u1', externalE164: null }) });
    expect(x).toContain('<Client>user_u1</Client>');
    expect(x).toContain('/api/twilio/ivr/voicemail');
  });

  it('an extension pointing at a real telephone dials the number', () => {
    const x = extensionTwiml(cfg, { target: ext('102') });
    expect(x).toContain('<Number>+15550001111</Number>');
  });
});

describe('the XML itself', () => {
  const all = [
    greetingTwiml(cfg, { open: true }),
    greetingTwiml(cfg, { open: false }),
    supportTransferTwiml(cfg),
    discoverTwiml(cfg),
    enqueueTwiml(cfg, { closed: false }),
    holdTwiml(cfg, { loop: 0, closed: false }),
    holdTwiml(cfg, { loop: 2, closed: false }),
    holdTwiml(cfg, { loop: 1, closed: true }),
    agentTwiml(cfg),
    voicemailTwiml(cfg, {}),
    invalidTwiml(cfg, { open: true }),
  ];

  it('every document is a well-formed TwiML response', () => {
    for (const x of all) {
      expect(x.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
      expect(x.endsWith('</Response>')).toBe(true);
    }
  });

  /*
   * The client will reword these prompts — that is why they live in a table.
   * An ampersand or a quote in the new wording must not produce XML Twilio
   * refuses to parse, which would take the whole phone line down.
   */
  it('prompt text with XML characters cannot break the document', () => {
    const nasty = { ...cfg, prompts: { ...cfg.prompts, greeting_open: 'Sales & "support" <here>' } };
    const x = greetingTwiml(nasty, { open: true });
    expect(x).toContain('Sales &amp; &quot;support&quot; &lt;here&gt;');
    expect(x).not.toContain('<here>');
  });

  it('every callback points at an absolute URL on our own origin', () => {
    for (const x of all) {
      for (const m of x.matchAll(/(?:action|waitUrl|recordingStatusCallback)="([^"]+)"/g)) {
        expect(m[1].startsWith('https://crm.example.com/')).toBe(true);
      }
    }
  });
});
