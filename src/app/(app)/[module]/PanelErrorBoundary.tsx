'use client';

/**
 * Keeps one failed drawer panel from taking the whole screen down.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 * Every panel in this drawer — Cases, Updates, Notes, Logins, Files,
 * Statements, Custom entries, Memberships, the pipeline bar — calls its Server
 * Actions as `startTransition(async () => { await someAction(...) })`, with no
 * rejection handling at any of the ~40 call sites. React routes an error thrown
 * inside an async transition to the nearest error boundary, and there was no
 * boundary anywhere in this application, so a single failed action unmounted
 * everything and replaced it with Next's bare "A server error occurred" page.
 * One dropped request while adding a case reply discarded every other unsaved
 * edit in the drawer.
 *
 * A boundary here means the failure stays the size of the thing that failed.
 * The record header, the pipeline bar, the tab strip and — crucially — any
 * field edits already made in this drawer all survive, and "Try again"
 * re-renders just this subtree.
 *
 * ── WHY A CLASS ───────────────────────────────────────────────────────────
 * `componentDidCatch` has no hook equivalent; a class is still the only way to
 * write a boundary in React. It is deliberately the whole of this file.
 *
 * ── RELATIONSHIP TO `(app)/error.tsx` ─────────────────────────────────────
 * That one catches failures in the SERVER render of a route and replaces the
 * page area. This one catches failures on the CLIENT, inside an already-
 * rendered drawer, and replaces only the panel. They do not overlap: an error
 * caught here never reaches that one.
 */
import { Component, type ReactNode } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('Drawer panel failed:', error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="rounded-xl border border-line bg-white p-5 text-center">
        <div className="mx-auto grid size-9 place-items-center rounded-full bg-warn-bg text-warn">
          <Icon name="alert-triangle" size={16} />
        </div>
        <p className="mt-2.5 text-[13.5px] font-medium text-ink-900">This tab didn&rsquo;t load</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
          The rest of this record is unaffected, and anything you already saved is safe.
        </p>
        <div className="mt-3.5">
          <Button size="sm" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
