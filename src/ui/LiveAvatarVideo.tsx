import { useEffect, useRef, useState } from "react";
import type { RemoteVideoTrack } from "livekit-client";

export function LiveAvatarVideo({ track, connecting }: { track: RemoteVideoTrack | null; connecting: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const element = video.current;
    setPlaying(false);
    if (!element || !track) return;
    track.attach(element);
    return () => { track.detach(element); element.srcObject = null; };
  }, [track]);
  return <div className={`live-avatar-frame ${playing ? "has-video" : ""}`}>
    <video ref={video} autoPlay playsInline muted aria-label="Alex’s live Boson avatar" onPlaying={() => setPlaying(true)} onEmptied={() => setPlaying(false)} />
    {!playing && <div className="live-avatar-waiting"><span className="live-avatar-symbol">✦</span><strong>{connecting ? "Connecting Alex’s avatar…" : "Meet Alex, face to face."}</strong><p>{connecting ? "Waiting for Boson’s live video track." : "Choose a preset, then start your lesson."}</p></div>}
    <span className="live-avatar-badge">{playing ? "LIVE · HIGGS AVATAR" : "LIVE AVATAR · NOT CONNECTED"}</span>
  </div>;
}
