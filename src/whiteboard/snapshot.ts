export interface BoardSnapshot { revision: number; image: string; fingerprint: string; changedAt: number; captureMs: number }
/** Export only the drawing surface, JPEG 0.76, 768 px longest side. The reusable
 * export canvas avoids DOM/SVG rasterization and allocating one canvas per edit. */
export function boardSnapshotter(source: HTMLCanvasElement) {
  const output = document.createElement("canvas");
  const scale = 768 / Math.max(source.width, source.height);
  output.width = Math.round(source.width * scale); output.height = Math.round(source.height * scale);
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("Whiteboard image export is unavailable.");
  return async (revision: number, changedAt: number): Promise<BoardSnapshot> => {
    const start = performance.now();
    ctx.drawImage(source, 0, 0, output.width, output.height);
    const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(b => b ? resolve(b) : reject(new Error("Whiteboard JPEG export failed.")), "image/jpeg", 0.76));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { revision, changedAt, image: btoa(binary), fingerprint: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join(""), captureMs: performance.now() - start };
  };
}
