import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { loadAvatarPhoto, removeAvatarPhoto, saveAvatarPhoto, validateAvatarFile, decodeAvatarFile, MAX_AVATAR_BYTES } from "../src/state/avatarPhoto";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

describe("local avatar photo storage", () => {
  it("persists the original photo blob, replaces it, and removes the saved copy", async () => {
    expect(await loadAvatarPhoto()).toBeNull();
    const first = { blob: new Blob(["first-photo"], { type: "image/png" }), name: "alex.png" };
    await saveAvatarPhoto(first);
    const restored = await loadAvatarPhoto();
    expect(restored?.name).toBe("alex.png");
    expect(restored?.blob.type).toBe("image/png");
    expect(await restored?.blob.text()).toBe("first-photo");
    await saveAvatarPhoto({ blob: new Blob(["replacement-photo"], { type: "image/jpeg" }), name: "new-alex.jpg" });
    const replacement = await loadAvatarPhoto();
    expect(replacement?.name).toBe("new-alex.jpg");
    expect(await replacement?.blob.text()).toBe("replacement-photo");
    await removeAvatarPhoto();
    expect(await loadAvatarPhoto()).toBeNull();
  });
  it("rejects unsafe/unsupported uploads without overwriting the previous portrait", async () => {
    await saveAvatarPhoto({ blob: new Blob(["photo"], { type: "image/webp" }), name: "alex.webp" });
    await expect(saveAvatarPhoto({ blob: new Blob(["<svg></svg>"], { type: "image/svg+xml" }), name: "not-a-photo.svg" })).rejects.toThrow("JPG, PNG or WebP");
    expect((await loadAvatarPhoto())?.name).toBe("alex.webp");
    expect(() => validateAvatarFile(new Blob([], { type: "image/png" }))).toThrow("empty");
    expect(() => validateAvatarFile(new Blob([new Uint8Array(MAX_AVATAR_BYTES + 1)], { type: "image/jpeg" }))).toThrow("too large");
  });
  it("reports unavailable browser storage rather than pretending the photo was saved", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(loadAvatarPhoto()).rejects.toThrow("unavailable");
    await expect(saveAvatarPhoto({ blob: new Blob(["photo"], { type: "image/png" }), name: "alex.png" })).rejects.toThrow("unavailable");
  });
  it("rejects corrupt image data and releases its temporary URL", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-avatar");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("Image", class { src = ""; async decode() { throw new Error("Invalid image bytes"); } });
    await expect(decodeAvatarFile(new Blob(["not-a-png"], { type: "image/png" }))).rejects.toThrow("could not be opened");
    expect(revoke).toHaveBeenCalledWith("blob:test-avatar");
    create.mockRestore(); revoke.mockRestore();
  });
});
