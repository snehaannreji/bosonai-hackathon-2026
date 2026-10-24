import { describe, expect, it } from "vitest";
import { configureAvatarCatalog, parseAvatarCatalog, selectLessonAvatar } from "../src/realtime/avatarCatalog";

const catalog = () => parseAvatarCatalog({ data: [
  { avatar_id: "builtin_emma_v1", name: "Emma", is_public: true },
  { avatar_id: "owned_alex_test", name: "Alex", is_public: false },
  { avatar_id: "builtin_claire_v1", name: "Claire", is_public: true },
] });

describe("live avatar account catalog and configuration", () => {
  it("retains account-owned avatars alongside the public preset fallback", () => {
    expect(catalog()).toEqual([
      { id: "builtin_emma_v1", name: "Emma", isPublic: true },
      { id: "owned_alex_test", name: "Alex", isPublic: false },
      { id: "builtin_claire_v1", name: "Claire", isPublic: true },
    ]);
  });
  it("selects the configured private ID and keeps presets selectable", () => {
    const result = configureAvatarCatalog(catalog(), " owned_alex_test ");
    expect(result.defaultAvatarId).toBe("owned_alex_test");
    expect(result.warning).toBeNull();
    expect(selectLessonAvatar(result, undefined)).toBe("owned_alex_test");
    expect(selectLessonAvatar(result, "builtin_emma_v1")).toBe("builtin_emma_v1");
  });
  it("honors an explicitly configured preset even when an owned avatar exists", () => {
    expect(configureAvatarCatalog(catalog(), "builtin_emma_v1").defaultAvatarId).toBe("builtin_emma_v1");
  });
  it("prefers an owned avatar when no explicit ID is configured", () => {
    expect(configureAvatarCatalog(catalog()).defaultAvatarId).toBe("owned_alex_test");
    expect(configureAvatarCatalog(catalog(), "  ").defaultAvatarId).toBe("owned_alex_test");
  });
  it("falls back to Claire with a notice if the configured custom ID is unavailable", () => {
    const result = configureAvatarCatalog(catalog(), "owned_not_accessible");
    expect(result.defaultAvatarId).toBe("builtin_claire_v1");
    expect(result.warning).toContain("unavailable");
    expect(selectLessonAvatar(result, undefined)).toBe("builtin_claire_v1");
  });
  it("continues working for accounts that only have presets, including without Claire", () => {
    const presets = catalog().filter(a => a.isPublic);
    expect(configureAvatarCatalog(presets).defaultAvatarId).toBe("builtin_claire_v1");
    expect(configureAvatarCatalog(presets.slice(0, 1)).defaultAvatarId).toBe("builtin_emma_v1");
  });
  it("rejects unknown requested IDs instead of sending guessed avatars to Boson", () => {
    const result = configureAvatarCatalog(catalog());
    for (const id of ["guessed_id", "", 123, null, "data:image/jpeg;base64,xxx"]) {
      expect(() => selectLessonAvatar(result, id)).toThrow("available to your Boson account");
    }
  });
  it("rejects malformed catalogs and filters invalid or duplicate entries", () => {
    expect(() => parseAvatarCatalog({ avatars: [] })).toThrow("invalid avatar catalog");
    expect(parseAvatarCatalog({ data: [null, {}, { avatar_id: "x" },
      { avatar_id: "", is_public: true }, { avatar_id: "x", is_public: false },
      { avatar_id: "x", name: "duplicate", is_public: true }] })).toEqual([{ id: "x", name: "x", isPublic: false }]);
  });
  it("does not invent a fallback ID when Boson returns no available avatars", () => {
    const result = configureAvatarCatalog([], "missing");
    expect(result.defaultAvatarId).toBe("");
    expect(() => selectLessonAvatar(result, undefined)).toThrow();
    expect(result.warning).toContain("no available avatars");
  });
});
