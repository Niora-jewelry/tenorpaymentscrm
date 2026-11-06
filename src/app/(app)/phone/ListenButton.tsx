'use client';

/**
 * "Listen", with the recording's length on it (client, Phone UI review).
 *
 * One small button instead of an audio bar per row: a list of calls with a
 * full player under each one was mostly players. Pressing it fetches the
 * 60-second signed link (addressed by id, never a path) and plays; pressing
 * again pauses. Only one recording plays at a time on the page.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { getRecordingUrlAction } from '../phoneActions';
import { callDuration } from './phoneBook';

export type ListenRecording = {
  id: string;
  kind: 'call' | 'voicemail';
  durationSeconds: number | null;
  storagePath: string | null;
};

/** The recording playing anywhere on the page, so starting one stops the other. */
let current: HTMLAudioElement | null = null;

export function ListenButton({ recording }: { recording: ListenRecording }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle');
  const [at, setAt] = useState(0);

  useEffect(
    () => () => {
      audio.current?.pause();
      if (current === audio.current) current = null;
    },
    [],
  );

  const label = recording.kind === 'voicemail' ? 'Voicemail' : 'Listen';
  const pill =
    'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

  // Twilio has finished the call but its recording has not landed yet.
  if (!recording.storagePath) {
    return (
      <span className={`${pill} border-line bg-canvas text-ink-400`} title="The recording is still being saved">
        <Spinner className="size-3" />
        {label}
      </span>
    );
  }

  const start = async () => {
    setState('loading');
    try {
      const url = await getRecordingUrlAction(recording.id);
      const el = new Audio(url);
      el.onplay = () => setState('playing');
      el.onpause = () => setState((s) => (s === 'playing' ? 'paused' : s));
      el.ontimeupdate = () => setAt(el.currentTime);
      el.onended = () => {
        setState('idle');
        setAt(0);
        audio.current = null;
        if (current === el) current = null;
      };
      el.onerror = () => {
        setState('error');
        audio.current = null;
      };
      audio.current = el;
      if (current && current !== el) current.pause();
      current = el;
      await el.play();
    } catch {
      setState('error');
      audio.current = null;
    }
  };

  const toggle = () => {
    const a = audio.current;
    if (a && state === 'playing') return a.pause();
    if (a && state === 'paused') {
      if (current && current !== a) current.pause();
      current = a;
      void a.play().catch(() => setState('error'));
      return;
    }
    void start();
  };

  const live = state === 'playing' || state === 'paused';
  const total = callDuration(recording.durationSeconds);
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={state === 'loading'}
      aria-label={`${state === 'playing' ? 'Pause' : label} ${recording.kind === 'voicemail' ? 'voicemail' : 'recording'}, ${total}`}
      title={state === 'error' ? 'Could not play that recording. Try again.' : undefined}
      className={`${pill} ${
        state === 'playing'
          ? 'border-brand-900 bg-brand-900 text-white'
          : state === 'error'
            ? 'border-bad/30 bg-bad-bg text-bad hover:border-bad/50'
            : 'border-line bg-white text-ink-700 hover:border-ink-300 hover:bg-canvas hover:text-ink-900'
      }`}
    >
      {state === 'loading' ? (
        <Spinner className="size-3" />
      ) : (
        <Icon name={state === 'playing' ? 'pause' : 'play'} size={10} strokeWidth={2.4} />
      )}
      {state === 'error' ? 'Retry' : label}
      <span
        className={`rounded-full px-1.5 py-px text-[10.5px] tabular ${
          state === 'playing' ? 'bg-white/20' : 'bg-canvas text-ink-500'
        }`}
      >
        {live ? `${callDuration(at)} / ${total}` : total}
      </span>
    </button>
  );
}
