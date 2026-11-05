'use client';

/**
 * Field Highlight Glows in the drawer (spec, 3 Nov 2026): who sees them, and the
 * "Field guide" key at the top. The rules themselves are `lib/records/fieldGlow`.
 *
 * The stage comes from the server on every render, so a Send Application or a
 * Void picked up by a refresh changes the colours by itself. The personal switch
 * is local first and saved behind it. It can only turn glows off: without the
 * permission there is no legend, so no switch to turn them on with.
 */
import { createContext, useContext, useMemo, useState, useTransition, type ReactNode } from 'react';
import { activeGlows, GLOW_MEANING, type Glow } from '@/lib/records/fieldGlow';
import type { GlowStage } from '@/lib/records/fieldNeeds';
import { setFieldGlowHiddenAction } from './glowActions';

type FieldGlowState = {
  stage: GlowStage;
  /** "See field highlights" is Yes and the personal switch is not hiding them. */
  showing: boolean;
  permitted: boolean;
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
};

const FieldGlowContext = createContext<FieldGlowState>({
  stage: 'none',
  showing: false,
  permitted: false,
  hidden: false,
  setHidden: () => {},
});

export const useFieldGlow = () => useContext(FieldGlowContext);

export function FieldGlowProvider({
  stage,
  permitted,
  hidden: savedHidden,
  children,
}: {
  stage: GlowStage;
  permitted: boolean;
  hidden: boolean;
  children: ReactNode;
}) {
  const [hidden, setHiddenState] = useState(savedHidden);
  const [, startSaving] = useTransition();
  const value = useMemo<FieldGlowState>(
    () => ({
      stage,
      permitted,
      hidden,
      showing: permitted && !hidden,
      setHidden: (next) => {
        setHiddenState(next);
        startSaving(async () => {
          try {
            await setFieldGlowHiddenAction({ hidden: next });
          } catch {
            // Not saved: say so by going back, rather than pretending it stuck.
            setHiddenState(!next);
          }
        });
      },
    }),
    [stage, permitted, hidden],
  );
  return <FieldGlowContext.Provider value={value}>{children}</FieldGlowContext.Provider>;
}

/** Put on the field's box. The colour and the pulse are CSS: `globals.css`. */
export function glowAttrs(glow: Glow | null, pulse: boolean) {
  if (!glow) return {};
  return {
    'data-glow': glow.kind,
    'data-pulse': pulse ? 'true' : undefined,
    title: glow.meaning,
  };
}

/** The key at the top of the drawer: the two colours in play, and the switch. */
export function FieldGuide() {
  const { stage, permitted, hidden, setHidden } = useFieldGlow();
  const kinds = activeGlows(stage);
  if (!permitted || kinds.length === 0) return null;
  return (
    <div data-field-guide className="mt-2 flex min-h-6 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11.5px] text-ink-500">
      <span className="font-semibold text-ink-600">Field guide</span>
      {hidden
        ? null
        : kinds.map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <span aria-hidden data-glow-swatch={kind} className="size-2.5 rounded-sm" />
              {GLOW_MEANING[kind]}
            </span>
          ))}
      <button
        type="button"
        aria-pressed={!hidden}
        onClick={() => setHidden(!hidden)}
        className="rounded px-1.5 py-0.5 font-medium text-brand-700 hover:bg-canvas"
      >
        {hidden ? 'Show highlights' : 'Hide highlights'}
      </button>
    </div>
  );
}
