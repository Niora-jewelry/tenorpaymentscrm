'use client';

/**
 * The browser softphone — one Twilio Device for the whole app.
 *
 * ── WHY IT IS MOUNTED APP-WIDE AND REGISTERS EAGERLY ─────────────────────
 * A lazily-created Device cannot RECEIVE calls. To ring when a merchant calls
 * back, the Device has to exist and be registered before anything happens, on
 * every page — so this provider sits in the `(app)` layout and builds the
 * Device on mount.
 *
 * Two consequences the integrator has to know, both accepted deliberately:
 *   • the microphone prompt may appear on first app load rather than on first
 *     dial. A denied microphone must leave the CRM completely usable and only
 *     degrade calling, which is why nothing in the render path depends on it.
 *   • a token request fires once per session, app-wide, instead of per dial.
 *
 * ── FAIL-SILENT IS LOAD-BEARING HERE ─────────────────────────────────────
 * Every await in the init path — the dynamic import, the token fetch, the
 * constructor, `register()` — lives inside `ensureDevice()`, and both callers
 * catch. Nothing in the render path can throw. A Twilio outage, a missing
 * environment variable or a user with no assigned number degrades CALLING; it
 * must never stop Leads, Deals or the drawer from rendering. The whole CRM
 * hanging because a phone token 500'd would be a far worse bug than not being
 * able to dial.
 *
 * ── MULTIPLE TABS — RESOLVED, AND HANDLED BELOW ──────────────────────────
 * Two tabs means two Devices registered on the same `user_<uuid>` identity.
 * Twilio's documented behaviour (confirmed by Donny 2026-09-17, from Twilio's
 * own docs rather than from a test of this code): the call is sent to ALL
 * devices holding that identity, whoever answers first gets it, and the other
 * legs are CANCELLED.
 *
 * That is why the `incoming` handler registers `cancel` alongside `accept` and
 * `disconnect`. Without it, answering in one tab would leave the call bar
 * stuck ringing forever in every other tab — the visible half of this is
 * handled, not left to chance.
 *
 * It also means a single inbound call produces exactly ONE `phone_calls` row:
 * the row is created by /api/twilio/voice, which runs once per call before
 * Twilio fans it out to any device, so the number of open tabs cannot multiply
 * the call log.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { dialAction } from '../phoneActions';
import { describePhoneError, type PhoneError } from '@/lib/phone/errors';

/** Minimal shapes — the SDK is imported dynamically, so it has no static type here. */
type TwilioCall = {
  accept: () => void;
  reject: () => void;
  disconnect: () => void;
  customParameters?: Map<string, string>;
  parameters?: Record<string, string>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

type DeviceState = 'idle' | 'starting' | 'ready' | 'error';

export type ActiveCall = {
  direction: 'in' | 'out';
  /** The other party, E.164. */
  peer: string;
  /** Our `phone_calls.id`, when we know it. Inbound learns it from Twilio. */
  callId: string | null;
  status: 'ringing' | 'connected';
};

/** The call that just finished, kept only long enough to offer a way back to
 *  it. Cleared when dismissed or when the next call starts. */
export type EndedCall = { callId: string | null; peer: string; direction: 'in' | 'out' };

type PhoneContextValue = {
  deviceState: DeviceState;
  /** Structured, so the UI can show a cause AND what to do about it. */
  error: PhoneError | null;
  activeCall: ActiveCall | null;
  /** Set the moment a call disconnects, so something can offer "view the
   *  recording" without the user hunting for the record again. */
  endedCall: EndedCall | null;
  dismissEndedCall: () => void;
  /** Null unless a call is ringing IN and has not been answered. */
  incoming: ActiveCall | null;
  dial: (to: string) => Promise<void>;
  hangUp: () => void;
  answer: () => void;
  reject: () => void;
};

const PhoneContext = createContext<PhoneContextValue | null>(null);

export function usePhone(): PhoneContextValue {
  const ctx = useContext(PhoneContext);
  if (!ctx) throw new Error('usePhone must be used inside <PhoneProvider>');
  return ctx;
}

export function PhoneProvider({ children }: { children: ReactNode }) {
  const [deviceState, setDeviceState] = useState<DeviceState>('idle');
  const [error, setError] = useState<PhoneError | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [endedCall, setEndedCall] = useState<EndedCall | null>(null);
  const [incoming, setIncoming] = useState<ActiveCall | null>(null);

  const deviceRef = useRef<unknown>(null);
  const callRef = useRef<TwilioCall | null>(null);
  const initRef = useRef<Promise<unknown> | null>(null);

  /**
   * Build and register the Device, at most once.
   *
   * Idempotent via `initRef`: the mount effect and a dial can both call it, and
   * the second one waits on the first rather than creating a second Device.
   */
  const ensureDevice = useCallback(async () => {
    if (deviceRef.current) return deviceRef.current;
    if (initRef.current) return initRef.current;

    initRef.current = (async () => {
      setDeviceState('starting');

      const res = await fetch('/api/twilio/token', { cache: 'no-store' });
      if (!res.ok) {
        // 403 means "no number assigned" or "not permitted" — both are ordinary
        // states for most users, not faults. They are reported quietly and the
        // rest of the CRM carries on.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `token request failed (${res.status})`);
      }
      const { token } = (await res.json()) as { token: string };

      // Dynamic import: the Voice SDK is ~100KB and touches browser-only APIs,
      // so it must not be in the server bundle or the initial payload.
      const { Device } = await import('@twilio/voice-sdk');
      const device = new Device(token, { logLevel: 'error' });

      device.on('registered', () => setDeviceState('ready'));
      device.on('error', (...args: unknown[]) => {
        setError(describePhoneError(args[0]));
        setDeviceState('error');
      });

      device.on('tokenWillExpire', async () => {
        // Refresh in place. A lapsed token silently stops inbound calls
        // arriving, which is the kind of failure nobody notices for a day.
        try {
          const refresh = await fetch('/api/twilio/token', { cache: 'no-store' });
          if (refresh.ok) {
            const { token: next } = (await refresh.json()) as { token: string };
            device.updateToken(next);
          }
        } catch {
          // Leave the stale token in place; the error handler above will fire
          // if it actually stops working.
        }
      });

      device.on('incoming', (call: TwilioCall) => {
        const peer = call.customParameters?.get('From') ?? call.parameters?.From ?? 'Unknown';
        const callId = call.customParameters?.get('CallId') ?? null;

        callRef.current = call;
        setIncoming({ direction: 'in', peer, callId, status: 'ringing' });

        call.on('accept', () => {
          setIncoming(null);
          setActiveCall({ direction: 'in', peer, callId, status: 'connected' });
        });
        call.on('disconnect', () => {
          callRef.current = null;
          setIncoming(null);
          // Captured BEFORE the state is cleared — `setActiveCall(null)` would
          // otherwise take the peer and the call id with it.
          setEndedCall({ direction: 'in', peer, callId });
          setActiveCall(null);
        });
        call.on('cancel', () => {
          callRef.current = null;
          setIncoming(null);
          setActiveCall(null);
        });
        call.on('reject', () => {
          callRef.current = null;
          setIncoming(null);
        });
      });

      await device.register();
      deviceRef.current = device;
      return device;
    })();

    try {
      return await initRef.current;
    } finally {
      // Clear the latch so a later attempt can retry after a failure.
      if (!deviceRef.current) initRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    ensureDevice().catch((err: Error) => {
      if (cancelled) return;
      // Not having a phone is normal for most users. Record the reason and
      // leave the app alone.
      setError(describePhoneError(err));
      setDeviceState('error');
    });
    return () => {
      cancelled = true;
    };
  }, [ensureDevice]);

  const dismissEndedCall = useCallback(() => setEndedCall(null), []);

  const dial = useCallback(
    async (to: string) => {
      setError(null);
      // The previous call's notice must not sit over the next one.
      setEndedCall(null);

      // The ROW COMES FIRST. Its id is handed to Twilio as a custom parameter
      // and is what the status and recording callbacks match on — a dial that
      // skipped this would connect fine and log nothing.
      const created = await dialAction(to);
      if (!created.ok) {
        setError({ message: created.message, kind: 'config', code: null });
        return;
      }

      try {
        const device = (await ensureDevice()) as {
          connect: (opts: { params: Record<string, string> }) => Promise<TwilioCall>;
        };

        setActiveCall({
          direction: 'out',
          peer: created.toE164,
          callId: created.callId,
          status: 'ringing',
        });

        const call = await device.connect({
          // `To` is what /api/twilio/voice reads; `CallId` is the correlation
          // key. Both names are a contract with that route — change one, change
          // both.
          params: { To: created.toE164, CallId: created.callId },
        });
        callRef.current = call;

        call.on('accept', () =>
          setActiveCall({
            direction: 'out',
            peer: created.toE164,
            callId: created.callId,
            status: 'connected',
          }),
        );
        call.on('disconnect', () => {
          callRef.current = null;
          setEndedCall({ direction: 'out', peer: created.toE164, callId: created.callId });
          setActiveCall(null);
        });
        call.on('cancel', () => {
          callRef.current = null;
          setActiveCall(null);
        });
        call.on('error', (...args: unknown[]) => {
          setError(describePhoneError(args[0]));
          callRef.current = null;
          setActiveCall(null);
        });
      } catch (err) {
        /* Kept: this one is a TWILIO error, not a Server Action rejection, so
           it carries a real code that describePhoneError can translate. */
        setError(describePhoneError(err));
        setActiveCall(null);
      }
    },
    [ensureDevice],
  );

  const hangUp = useCallback(() => {
    callRef.current?.disconnect();
    callRef.current = null;
    setActiveCall(null);
  }, []);

  const answer = useCallback(() => callRef.current?.accept(), []);
  const reject = useCallback(() => {
    callRef.current?.reject();
    callRef.current = null;
    setIncoming(null);
  }, []);

  return (
    <PhoneContext.Provider
      value={{ deviceState, error, activeCall, incoming, endedCall, dismissEndedCall, dial, hangUp, answer, reject }}
    >
      {children}
    </PhoneContext.Provider>
  );
}
