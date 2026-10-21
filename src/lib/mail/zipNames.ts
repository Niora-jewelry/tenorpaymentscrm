/** File names for "Download all": safe inside a zip, and unique ("a.pdf", "a (2).pdf"). Pure. */
export function zipNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((raw) => {
    const clean = raw.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^\.+/, '_').trim().slice(0, 180) || 'attachment';
    const key = clean.toLowerCase();
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    if (n === 0) return clean;
    const dot = clean.lastIndexOf('.');
    return dot > 0 ? `${clean.slice(0, dot)} (${n + 1})${clean.slice(dot)}` : `${clean} (${n + 1})`;
  });
}
