import { afterEach, describe, expect, it, vi } from "vitest";
import { lessonAssessor, prepareLesson } from "../src/realtime/lessonApi";
import { coveredInstructorGuideFactIds, MAX_INSTRUCTOR_NOTES_LENGTH, mockLesson, normalizeInstructorNotes } from "../src/state/lesson";

afterEach(() => vi.unstubAllGlobals());

describe("instructor reference notes", () => {
  it("normalizes text notes and enforces the size and content limits", () => {
    expect(normalizeInstructorNotes("\uFEFF  alpha\r\nbeta  ")).toBe("alpha\nbeta");
    expect(() => normalizeInstructorNotes("x".repeat(MAX_INSTRUCTOR_NOTES_LENGTH + 1))).toThrow("characters or fewer");
    expect(() => normalizeInstructorNotes("plain\u0000text")).toThrow("control characters");
    expect(() => normalizeInstructorNotes({})).toThrow("plain text");
  });

  it("completes uploaded-note facts on direct speech matches even if semantic assessment misses their IDs", () => {
    const sourceText = "Canada holds the world record for the longest total coastline, stretching over 202,080 kilometers and touching the Atlantic, Pacific, and Arctic oceans.";
    const guide = [
      { id: "guide-coastline", text: "Canada has the world's longest coastline.", sourceText, conceptId: "concept_1" },
      { id: "guide-lakes", text: "Canada has many freshwater lakes.", sourceText: "Canada is home to over 60% of the world's natural lakes, with about 9% of its total area covered by freshwater.", conceptId: "concept_1" },
    ];
    const taught = coveredInstructorGuideFactIds(
      guide,
      "Canada holds the world record for the longest total coastline, stretching over 202,080 kilometers and touching the Atlantic, Pacific, and Arctic oceans.",
    );

    expect(taught).toEqual(["guide-coastline"]);
    expect(coveredInstructorGuideFactIds(guide, "Canada is a country.")).toEqual([]);
    expect(coveredInstructorGuideFactIds(guide, sourceText, ["guide-lakes"])).toEqual(["guide-lakes", "guide-coastline"]);
  });

  it("sends notes with lesson preparation without attaching them to the student lesson", async () => {
    const notes = "The capital of Freedonia is Sylvania.";
    const lesson = mockLesson("Freedonian geography", 0, "Claire");
    const instructorGuide = [{ id: "guide-1", text: "Sylvania is the capital of Freedonia.", conceptId: "concept_1" }];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ lesson, instructorGuide }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareLesson("Freedonian geography", false, 0, "Claire", notes);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ instructorNotes: notes });
    expect(prepared).toEqual({ lesson, instructorGuide });
    expect(prepared.lesson).not.toHaveProperty("instructorNotes");
    expect(prepared.lesson).not.toHaveProperty("instructorGuide");
  });

  it("maps only server-confirmed covered note facts onto the private assessment result", async () => {
    const guide = [
      { id: "guide-1", text: "Sylvania is the capital.", conceptId: "concept_1" },
      { id: "guide-2", text: "It lies near the coast.", conceptId: "concept_2" },
    ];
    const assessment = { matchedCriteria: [], matchedConcepts: [], misconception: false, reason: "", factAccuracy: "accurate", groundTruth: "", taughtGuideFactIds: ["guide-2"], independentFactTaught: true, topicFactTaught: true };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ assessment }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await lessonAssessor(mockLesson("Freedonian geography"), guide)({
      concept: { id: "concept_1", label: "Main idea", goal: "Explain the idea", criteria: ["A", "B"], initialBelief: null },
      turns: [{ id: "human-1", text: "Sylvania lies near the coast." }],
      quote: "Sylvania lies near the coast.",
    });
    expect(result.taughtGuideFactIds).toEqual(["guide-2"]);
    expect(result.taughtGuideFacts).toEqual([guide[1]]);
    expect(result.independentFactTaught).toBe(true);
    expect(result.topicFactTaught).toBe(true);
  });

  it("rejects oversized notes before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(prepareLesson("A topic", false, 0, "Claire", "x".repeat(MAX_INSTRUCTOR_NOTES_LENGTH + 1))).rejects.toThrow("characters or fewer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not attempt a network lesson in local mock mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const prepared = await prepareLesson("A topic", true, 0, "Claire", "Instructor reference");
    expect(prepared.lesson.mock).toBe(true);
    expect(prepared.instructorGuide).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
