import { describe, expect, it, vi } from "vitest";
import { catalogCache } from "../src/realtime/catalogCache";
describe("Boson catalog request cache", () => {
  it("deduplicates simultaneous development-mode requests and reuses the successful result", async () => {
    let resolve!: (value: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>(r => { resolve = r; }));
    const cached = catalogCache(load);
    const first = cached(), second = cached(); resolve(["Claire", "Emma", "James"]);
    expect(await first).toEqual(await second); expect(await cached()).toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("does not cache provider errors, so the retry button can recover", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(["Claire"]);
    const cached = catalogCache(load);
    await expect(cached()).rejects.toThrow("429"); expect(await cached()).toEqual(["Claire"]);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("refreshes the catalog when its successful cache expires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const load = vi.fn(async () => ["Claire"]); const cached = catalogCache(load, 100);
    await cached(); now.mockReturnValue(1101); await cached();
    expect(load).toHaveBeenCalledTimes(2); now.mockRestore();
  });
});
