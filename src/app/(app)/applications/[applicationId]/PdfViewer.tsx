'use client';

/**
 * The returned PDF, "shown alongside" the review (spec). Drawn page by page
 * onto canvases with pdf.js rather than framed: the app sends
 * X-Frame-Options: DENY for every response, its own included, and a file
 * holding SSNs should not be rendered as a page on our origin anyway.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';

export function PdfViewer({ fileId, name }: { fileId: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let doc: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
        const res = await fetch(`/api/applications/files/${fileId}?view`, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data = new Uint8Array(await res.arrayBuffer());
        const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
        doc = pdf;
        if (cancelled || !host.current) return;
        host.current.replaceChildren();
        const width = host.current.clientWidth - 2;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const scale = (width / base.width) * zoom;
          const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.width = `${(vp.width / (window.devicePixelRatio || 1)).toFixed(0)}px`;
          canvas.className = 'mx-auto mb-3 block rounded-md bg-white shadow-[0_1px_3px_rgba(8,32,47,.18)]';
          canvas.setAttribute('aria-label', `Page ${i} of ${pdf.numPages}`);
          host.current?.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
          if (cancelled) return;
        }
        setPages(pdf.numPages);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [fileId, zoom]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <Icon name="file-text" size={14} className="shrink-0 text-[#b02a30]" />
        <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-800" title={name}>
          {name}
        </p>
        {pages ? <span className="text-[11.5px] tabular-nums text-ink-400">{pages} page{pages === 1 ? '' : 's'}</span> : null}
        <div className="flex items-center rounded-md border border-line">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))} className="grid size-7 place-items-center text-ink-500 hover:bg-canvas">
            −
          </button>
          <span className="w-10 text-center text-[11.5px] tabular-nums text-ink-500">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))} className="grid size-7 place-items-center text-ink-500 hover:bg-canvas">
            +
          </button>
        </div>
        <a href={`/api/applications/files/${fileId}`} className="grid size-7 place-items-center rounded-md text-ink-500 hover:bg-canvas hover:text-ink-900" aria-label="Download PDF" title="Download PDF">
          <Icon name="download" size={14} />
        </a>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto bg-canvas p-3">
        {state === 'loading' ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[12.5px] text-ink-400">
            <Spinner /> Opening the PDF…
          </div>
        ) : null}
        {state === 'error' ? (
          <p className="m-4 flex items-center gap-2 rounded-lg bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
            <Icon name="alert-triangle" size={13} /> The PDF could not be shown. Download it instead.
          </p>
        ) : null}
        <div ref={host} className={state === 'error' ? 'hidden' : ''} />
      </div>
    </div>
  );
}
