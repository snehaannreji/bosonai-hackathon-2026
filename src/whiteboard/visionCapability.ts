/** This is the capability of our implemented adapter, not a claim that Boson's
 * private research model lacks vision. Enable only after a verified protocol
 * and an end-to-end current-frame recognition test are implemented. */
export const VISION_BLOCKER = "Live whiteboard sharing is unavailable: Boson's Realtime 1.5 camera-input protocol has not been supplied. The student cannot see this board through the current audio-only connection.";
export function visionCapability(model: string) {
  return {
    model,
    adapterReady: false as const,
    transport: null,
    modelVisionConfirmed: false as const,
    reason: VISION_BLOCKER,
  };
}
