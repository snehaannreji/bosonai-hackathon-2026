import { useEffect, useRef, useState, type DragEvent } from "react";
import { decodeAvatarFile, loadAvatarPhoto, removeAvatarPhoto, saveAvatarPhoto, type AvatarPhoto as Photo } from "../state/avatarPhoto";

/** A persistent photo portrait, explicitly distinct from a live video track. */
export function AvatarPhoto() {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    void loadAvatarPhoto().then(saved => { if (active) { setPhoto(saved); setPersisted(Boolean(saved)); } })
      .catch(() => { if (active) setNotice("Photos can be shown here, but this browser’s photo storage is unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!photo) { setUrl(null); return; }
    const next = URL.createObjectURL(photo.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [photo]);

  const choose = async (file?: File) => {
    if (!file || pending.current || loading) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await decodeAvatarFile(file);
      const next = { blob: file, name: file.name };
      setPhoto(next); setPersisted(false);
      try { await saveAvatarPhoto(next); setPersisted(true); }
      catch { setNotice("Your photo is visible for this visit, but could not be saved for next time."); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not use that photo."); }
    finally { pending.current = false; setBusy(false); if (input.current) input.current.value = ""; }
  };
  const remove = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    setPhoto(null); setPersisted(false);
    try { await removeAvatarPhoto(); }
    catch { setNotice("Photo removed for this visit. Browser storage could not be updated, so a saved copy may return after refresh."); }
    finally { pending.current = false; setBusy(false); }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false);
    if (event.dataTransfer.files.length !== 1) { setError("Choose one photo for Alex."); return; }
    void choose(event.dataTransfer.files[0]);
  };

  return <div className={`photo-avatar ${dragging ? "dragging" : ""}`} onDragOver={e => { e.preventDefault(); if (!busy && !loading) setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop} aria-busy={busy || loading}>
    {url ? <figure className="student-photo-frame"><img className="student-photo" src={url} alt="Alex’s uploaded avatar" /><figcaption>Photo avatar · Not animated</figcaption></figure>
      : <div className="avatar-orbit"><div className="avatar-initial">a<span>✦</span></div></div>}
    <input ref={input} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload Alex’s avatar photo" disabled={busy || loading} onChange={e => void choose(e.target.files?.[0])} />
    <div className="photo-actions"><button type="button" disabled={busy || loading} onClick={() => input.current?.click()}>{loading ? "Loading photo…" : busy ? "Saving…" : photo ? "Change photo" : "Upload a photo"}</button>{photo && <button type="button" className="photo-remove" disabled={busy || loading} onClick={() => void remove()}>Remove</button>}</div>
    <p className="photo-help">{photo ? persisted ? "Saved in this browser. You can keep talking with Alex." : "Your photo is visible for this visit." : "Or drop a photo here · JPG, PNG or WebP · Up to 10 MB"}</p>
    <p className="photo-privacy">Your photo stays in this browser.</p>
    {error && <p className="photo-error" role="alert">{error}</p>}
    {notice && <p className="photo-error" role="status">{notice}</p>}
  </div>;
}
