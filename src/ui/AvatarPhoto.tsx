import { useEffect, useRef, useState, type DragEvent } from "react";
import { decodeAvatarFile, loadAvatarPhoto, removeAvatarPhoto, saveAvatarPhoto, type AvatarPhoto as Photo } from "../state/avatarPhoto";
import type { CharacterId } from "../state/characters";

/** A persistent photo portrait, explicitly distinct from a live video track. */
type AvatarStream = { body: ReadableStream<Uint8Array>; contentType: string; key: string };

export function AvatarPhoto({ name = "Alex", characterId = "alex", onPhotoChange, photoSentToProvider = false, disabled = false, videoSrc, videoStream, clipPreparing = false, onClipPlaying, onClipEnded, onClipError }: { name?: string; characterId?: CharacterId; onPhotoChange?: (photo: Blob | null) => void; photoSentToProvider?: boolean; disabled?: boolean; videoSrc?: string; videoStream?: AvatarStream | null; clipPreparing?: boolean; onClipPlaying?: () => void; onClipEnded?: () => void; onClipError?: (message?: string) => void }) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [needsSoundClick, setNeedsSoundClick] = useState(false);
  const pending = useRef(false);
  const playRequested = useRef(false);
  const blocked = disabled || busy || loading;

  useEffect(() => {
    let active = true;
    setLoading(true); setPhoto(null); setPersisted(false);
    void loadAvatarPhoto(characterId).then(saved => { if (active) { setPhoto(saved); setPersisted(Boolean(saved)); onPhotoChange?.(saved?.blob ?? null); } })
      .catch(() => { if (active) setNotice("Photos can be shown here, but this browser’s photo storage is unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [characterId]);
  useEffect(() => {
    if (!photo) { setUrl(null); return; }
    const next = URL.createObjectURL(photo.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [photo]);
  useEffect(() => {
    setVideoReady(false);
    setNeedsSoundClick(false);
    playRequested.current = false;
    if (!videoSrc || !video.current) return;
    video.current.pause();
    video.current.muted = false;
  }, [videoSrc, videoStream?.key]);

  useEffect(() => {
    if (!videoStream || !video.current) return;
    if (typeof MediaSource === "undefined") { onClipError?.("This browser cannot play streamed clips. Try another reply."); return; }
    const player = video.current;
    const source = new MediaSource();
    const objectUrl = URL.createObjectURL(source);
    player.src = objectUrl;
    const reader = videoStream.body.getReader();
    let cancelled = false;
    const waitFor = (target: EventTarget, eventName: string) => new Promise<void>((resolve, reject) => {
      const done = () => { target.removeEventListener(eventName, done); target.removeEventListener("error", failed); resolve(); };
      const failed = () => { target.removeEventListener(eventName, done); target.removeEventListener("error", failed); reject(new Error("The streamed video decoder failed.")); };
      target.addEventListener(eventName, done, { once: true });
      target.addEventListener("error", failed, { once: true });
    });
    const pump = async () => {
      if (source.readyState !== "open") await waitFor(source, "sourceopen");
      const baseType = videoStream.contentType.split(";")[0] || "video/mp4";
      const candidates = [videoStream.contentType, `${baseType}; codecs="avc1.42E01E, mp4a.40.2"`, `${baseType}; codecs="avc1.4D401E, mp4a.40.2"`, `${baseType}; codecs="avc1.64001F, mp4a.40.2"`, baseType];
      const mime = candidates.find(type => MediaSource.isTypeSupported(type));
      if (!mime) throw new Error("This browser does not support Boson's streamed video format.");
      const buffer = source.addSourceBuffer(mime);
      while (!cancelled) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (buffer.updating) await waitFor(buffer, "updateend");
        if (cancelled) return;
        const data = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
        const appended = waitFor(buffer, "updateend");
        buffer.appendBuffer(data);
        await appended;
      }
      if (!cancelled && source.readyState === "open") source.endOfStream();
    };
    void pump().catch(error => { if (!cancelled) onClipError?.(error instanceof Error ? error.message : "Could not decode the streamed clip."); });
    return () => {
      cancelled = true;
      void reader.cancel().catch(() => {});
      player.pause(); player.removeAttribute("src"); player.load();
      URL.revokeObjectURL(objectUrl);
    };
  }, [videoStream]);

  const startVideoWithSound = () => {
    const player = video.current;
    if (!player || playRequested.current) return;
    if (!player.videoWidth || !player.videoHeight) { onClipError?.("The generated clip has audio but no video frames. Try another reply."); return; }
    playRequested.current = true;
    player.muted = false;
    void player.play().catch(() => { playRequested.current = false; setNeedsSoundClick(true); });
  };

  const choose = async (file?: File) => {
    if (!file || pending.current || blocked) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await decodeAvatarFile(file);
      const next = { blob: file, name: file.name };
      setPhoto(next); setPersisted(false);
      onPhotoChange?.(file);
      try { await saveAvatarPhoto(next, characterId); setPersisted(true); }
      catch { setNotice("Your photo is visible for this visit, but could not be saved for next time."); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not use that photo."); }
    finally { pending.current = false; setBusy(false); if (input.current) input.current.value = ""; }
  };
  const remove = async () => {
    if (pending.current || blocked) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    setPhoto(null); setPersisted(false);
    onPhotoChange?.(null);
    try { await removeAvatarPhoto(characterId); }
    catch { setNotice("Photo removed for this visit. Browser storage could not be updated, so a saved copy may return after refresh."); }
    finally { pending.current = false; setBusy(false); }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); setDragging(false);
    if (event.dataTransfer.files.length !== 1) { setError(`Choose one photo for ${name}.`); return; }
    void choose(event.dataTransfer.files[0]);
  };

  const talkingPortraits: Partial<Record<CharacterId, string>> = { "baby-yoda": "/characters/baby-yoda.jpeg", kevin: "/characters/kevin.jpeg?v=2" };
  const talkingPortrait = Boolean(talkingPortraits[characterId]);
  const portraitUrl = url ?? talkingPortraits[characterId] ?? null;
  return <div className={`photo-avatar ${dragging ? "dragging" : ""}`} onDragOver={e => { e.preventDefault(); if (!blocked) setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }} onDrop={drop} aria-busy={busy || loading}>
    {portraitUrl ? <figure className={`student-photo-frame ${talkingPortrait ? "baby-avatar-frame" : ""} ${characterId === "kevin" ? "kevin-avatar-frame" : ""}`}>
        <img className="student-photo" src={portraitUrl} alt={talkingPortrait ? `${name} portrait ready to animate` : `${name}’s uploaded avatar`} />
        {talkingPortrait && (videoSrc || videoStream) && <video ref={video} className={`baby-generated-video ${videoReady ? "video-ready" : ""}`} key={videoStream?.key ?? videoSrc} src={videoSrc} playsInline controls={false} disablePictureInPicture preload="auto" onLoadedMetadata={() => { if (!video.current?.videoWidth || !video.current?.videoHeight) onClipError?.("The generated clip has audio but no video frames. Try another reply."); }} onLoadedData={startVideoWithSound} onPlaying={() => { if (!video.current?.videoWidth || !video.current?.videoHeight) { onClipError?.("The generated clip has audio but no video frames. Try another reply."); return; } setVideoReady(true); setNeedsSoundClick(false); onClipPlaying?.(); }} onEnded={onClipEnded} onError={() => onClipError?.("Could not load the generated talking clip. Try another reply.")} />}
        {talkingPortrait && clipPreparing && !videoSrc && <div className="baby-preparing" role="status"><span className="baby-loading-dot" />Preparing…</div>}
        {talkingPortrait && videoSrc && needsSoundClick && <button type="button" className="baby-play-sound" onClick={() => { const player = video.current; if (!player) return; player.muted = false; void player.play().then(() => setNeedsSoundClick(false)).catch(() => setNeedsSoundClick(true)); }}>Play with sound</button>}
        {!(talkingPortrait && videoSrc && videoReady) && <figcaption>{talkingPortrait ? photoSentToProvider ? `${name} image · Ready to animate` : `${name} portrait · Still image` : "Photo avatar · Not animated"}</figcaption>}
      </figure> : <div className="avatar-orbit"><div className="avatar-initial">a<span>✦</span></div></div>}
    <input ref={input} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-label={`Upload ${name}’s avatar photo`} disabled={blocked} onChange={e => void choose(e.target.files?.[0])} />
    <div className="photo-actions"><button type="button" disabled={blocked} onClick={() => input.current?.click()}>{loading ? "Loading photo…" : busy ? "Saving…" : photo ? "Change photo" : talkingPortrait ? "Upload a different photo" : "Upload a photo"}</button>{photo && <button type="button" className="photo-remove" disabled={blocked} onClick={() => void remove()}>Remove</button>}</div>
    <p className="photo-help">{photo ? persisted ? `Saved in this browser. You can keep talking with ${name}.` : "Your photo is visible for this visit." : talkingPortrait ? `Using the included ${name} picture. Upload another to replace it.` : "Or drop a photo here · JPG, PNG or WebP · Up to 10 MB"}</p>
    <p className="photo-privacy">{photoSentToProvider ? photo ? "Your uploaded portrait is sent to Boson to render each talking clip and is also saved in this browser." : `The included ${name} picture is sent to Boson to render each talking clip.` : "Your photo stays in this browser."}</p>
    {error && <p className="photo-error" role="alert">{error}</p>}
    {notice && <p className="photo-error" role="status">{notice}</p>}
  </div>;
}
