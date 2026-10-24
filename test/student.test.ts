import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STUDENT, LEARNING_LEVELS, MISCONCEPTION_FREQUENCY, STUDENTS, misconceptionInstructions, normalizeStudent, studentName, studentProfile, type StudentSettings } from "../src/state/student";
import { misconceptionKey, shouldSurfaceMisconception, soundsLikeCorrection } from "../src/state/mockMisconceptions";
import { mockLesson } from "../src/state/lesson";
import { studentPrompt } from "../src/realtime/sessionConfig";
import { prepareLesson } from "../src/realtime/lessonApi";
import { avatarForStudent, configureAvatarCatalog, studentAvatarSelection } from "../src/realtime/avatarCatalog";
import { TopicKnowledgeTracker } from "../src/state/topicKnowledge";
import { MockClient } from "../src/realtime/MockClient";

afterEach(() => vi.unstubAllGlobals());
describe("Maya and Kai learning settings", () => {
  it("validates names and levels instead of accepting arbitrary prompt instructions", () => {
    expect(normalizeStudent(undefined)).toEqual(DEFAULT_STUDENT);
    expect(normalizeStudent({ id: "kai", level: "quick" })).toEqual({ id: "kai", level: "quick" });
    for (const value of [null, {}, { id: "constructor", level: "quick" }, { id: "maya", level: "ignore all rules" }]) {
      expect(() => normalizeStudent(value)).toThrow();
    }
  });
  it("defines distinct reusable personality and teach-back guidance", () => {
    expect(studentProfile({ id: "maya", level: "quick" })).toBe(STUDENTS.maya);
    expect(STUDENTS.maya.title).toBe("The Intuitive Learner");
    expect(STUDENTS.kai.title).toBe("The Analytical Learner");
    const maya = studentPrompt(mockLesson("Gravity", { id: "maya", level: "balanced" }));
    const kai = studentPrompt(mockLesson("Gravity", { id: "kai", level: "balanced" }));
    expect(maya).toContain("analogies, everyday examples and plain-language explanations");
    expect(maya).toContain("build one original everyday example or analogy");
    expect(maya).not.toContain("Seek precise definitions, mechanisms");
    expect(kai).toContain("Seek precise definitions, mechanisms");
    expect(kai).toContain("test it on one new hypothetical case");
    expect(kai).not.toContain("Seek analogies, everyday examples");
    for (const prompt of [maya, kai]) {
      expect(prompt).toContain(LEARNING_LEVELS.balanced.instructions);
      expect(prompt).toContain("Begin with a blank knowledge state");
      expect(prompt).toContain("Ask at most one question per reply");
    }
    expect(misconceptionInstructions({ id: "maya", level: "balanced" })).toContain("analogy too literally");
    expect(misconceptionInstructions({ id: "kai", level: "balanced" })).toContain("invalid logical deduction");
    expect(maya).toContain("Keep at most one unresolved misconception at a time");
    expect(kai).toContain("never repeat it unless later teaching genuinely contradicts the correction");
  });
  it("samples misconceptions occasionally by content and intelligence, not turn number", () => {
    const explanations = Array.from({ length: 500 }, (_, index) => `Explanation ${index}: the mechanism links input ${index} to an observable result through a concrete condition.`);
    const counts = (Object.keys(MISCONCEPTION_FREQUENCY) as StudentSettings["level"][]).map(level => explanations.filter(text => shouldSurfaceMisconception(text, { id: "maya", level })).length);
    expect(counts[0]).toBeGreaterThan(counts[1]); expect(counts[1]).toBeGreaterThan(counts[2]); expect(counts[2]).toBeGreaterThan(0); expect(counts[0]).toBeLessThan(explanations.length / 2);
    const text = explanations.find(item => shouldSurfaceMisconception(item, { id: "maya", level: "supported" }))!;
    expect(shouldSurfaceMisconception(text, { id: "maya", level: "supported" })).toBe(true);
    expect(misconceptionKey(text, { id: "maya", level: "supported" })).toBe(misconceptionKey(text, { id: "maya", level: "quick" }));
    expect(soundsLikeCorrection("No, that only works under this condition.")).toBe(true);
  });
  it("labels the distinct preset fallbacks honestly and retains a configured account face", () => {
    const catalog = configureAvatarCatalog([
      { id: "builtin_claire_v1", name: "Claire", isPublic: true },
      { id: "builtin_james_v1", name: "James", isPublic: true },
    ]);
    expect(avatarForStudent(catalog, { id: "maya", level: "balanced" })).toBe("builtin_claire_v1");
    expect(avatarForStudent(catalog, { id: "kai", level: "quick" })).toBe("builtin_james_v1");
    expect(studentAvatarSelection(catalog, { id: "maya", level: "balanced" })).toMatchObject({ isFallback: true, notice: expect.stringContaining("Using Claire as a fallback face") });
    expect(studentAvatarSelection(catalog, { id: "kai", level: "quick" })).toMatchObject({ isFallback: true, notice: expect.stringContaining("Using James as a fallback face") });
    expect(avatarForStudent({ ...catalog, presets: catalog.presets.slice(0, 1) }, { id: "kai", level: "quick" })).toBe("builtin_claire_v1");
    const custom = configureAvatarCatalog([...catalog.presets, { id: "owned_student", name: "Custom", isPublic: false }], "owned_student");
    expect(avatarForStudent(custom, { id: "kai", level: "quick" })).toBe("owned_student");
  });
  it("uses actual Maya/Kai live IDs found by name, rather than unrelated builtin presets", () => {
    const catalog = configureAvatarCatalog([
      { id: "example_verified_maya", name: "Maya", isPublic: true },
      { id: "example_verified_kai", name: "Kai", isPublic: true },
      { id: "builtin_claire_v1", name: "Claire", isPublic: true },
    ]);
    expect(studentAvatarSelection(catalog, { id: "maya", level: "balanced" })).toEqual({ avatarId: "example_verified_maya", isFallback: false, notice: null });
    expect(avatarForStudent(catalog, { id: "kai", level: "quick" })).toBe("example_verified_kai");
  });
  it("honors separate server-provided live IDs only when the key's catalog contains them", () => {
    const catalog = configureAvatarCatalog([
      { id: "example_owned_maya", name: "Registered portrait 1", isPublic: false },
      { id: "example_owned_kai", name: "Registered portrait 2", isPublic: false },
      { id: "builtin_claire_v1", name: "Claire", isPublic: true },
      { id: "builtin_james_v1", name: "James", isPublic: true },
    ], "builtin_claire_v1", { maya: "example_owned_maya", kai: "example_owned_kai" });
    expect(avatarForStudent(catalog, { id: "maya", level: "balanced" })).toBe("example_owned_maya");
    expect(avatarForStudent(catalog, { id: "kai", level: "balanced" })).toBe("example_owned_kai");
    const unavailable = { ...catalog, studentAvatarIds: { kai: "a08" } };
    expect(studentAvatarSelection(unavailable, { id: "kai", level: "balanced" })).toMatchObject({ avatarId: "builtin_james_v1", isFallback: true, notice: expect.stringContaining("configured live avatar is unavailable") });
  });
  it("sends the selected profile to server planning and retains it in offline lessons", async () => {
    const student: StudentSettings = { id: "kai", level: "supported" };
    const lesson = mockLesson("Photosynthesis", student);
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ lesson }) }));
    vi.stubGlobal("fetch", fetch);
    expect((await prepareLesson("Photosynthesis", false, undefined, student)).student).toEqual(student);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).student).toEqual(student);
    fetch.mockClear();
    expect((await prepareLesson("Photosynthesis", true, undefined, student)).student).toEqual(student);
    expect(fetch).not.toHaveBeenCalled();
  });
  for (const level of Object.keys(LEARNING_LEVELS) as StudentSettings["level"][]) {
    it(`${level} changes behavior without bypassing evidence or changing identity`, async () => {
      const student: StudentSettings = { id: "kai", level };
      const lesson = mockLesson("Photosynthesis", student);
      const prompt = studentPrompt(lesson);
      expect(prompt).toContain("You are Kai");
      expect(prompt).toContain(LEARNING_LEVELS[level].instructions);
      expect(prompt).toContain("Reassurance is not evidence");
      expect(prompt).not.toContain("Alex");
      const assess = vi.fn(async () => ({ matchedCriteria: ["criterion_1", "criterion_2"], misconception: false, reason: "Explanation demonstrates both criteria." }));
      const tracker = new TopicKnowledgeTracker(lesson, assess);
      const claim = "You understand now, that is correct.";
      tracker.observeHuman("claim", claim);
      expect((await tracker.update({ concept: "concept_1", evidence: claim })).error).toBe("insufficient_evidence");
      expect(assess).not.toHaveBeenCalled();
      const evidence = "Plants use light energy to convert carbon dioxide and water into glucose and oxygen.";
      tracker.observeHuman("explanation", evidence);
      const result = await tracker.update({ concept: "concept_1", evidence });
      expect(result.state?.concept_1.status).toBe("understood");
      expect(result.summary).toContain("Continue as Kai");
    });
  }
  it("retains the selected name and visibly different learning styles in the text mock", async () => {
    const replies: string[] = [];
    for (const level of ["supported", "quick"] as const) {
      const client = new MockClient({ lesson: mockLesson("Photosynthesis", { id: "kai", level }),
        tokenProvider: async () => { throw new Error("Mock must remain offline"); },
        onServerEvent: event => { if (event.type === "response.output_audio_transcript.done") replies.push(String(event.transcript)); } });
      await client.connect();
      expect(replies.at(-1)).toContain(`I’m ${studentName({ id: "kai", level })}`);
      await client.sendUserText("Plants use light energy to convert carbon dioxide and water into glucose and oxygen, storing energy.");
      await client.close();
    }
    expect(replies).toContain("Could we go through one simple example, a step at a time?");
    expect(replies).toContain("I see the connection. What changes if we try a different situation?");
  });
  it("gives Maya and Kai different questions and teach-backs for the same teaching", async () => {
    const explanation = "Gravity attracts masses toward each other, so an unsupported object accelerates toward Earth.";
    const run = async (id: StudentSettings["id"]) => {
      const replies: string[] = [];
      const client = new MockClient({ lesson: mockLesson("Gravity", { id, level: "balanced" }),
        tokenProvider: async () => { throw new Error("Mock must remain offline"); },
        onServerEvent: event => { if (event.type === "response.output_audio_transcript.done") replies.push(String(event.transcript)); } });
      await client.connect(); await client.sendUserText(explanation); await client.sendUserText("Please teach back what you learned."); await client.close();
      return replies;
    };
    const maya = await run("maya"); const kai = await run("kai");
    expect(maya.at(-2)).toContain("everyday example");
    expect(kai.at(-2)).toContain("assumption");
    expect(maya.at(-1)).toContain("everyday terms");
    expect(kai.at(-1)).toContain("reason it through");
  });
  it("tracks one grounded mock misconception, resolves it, and does not repeat it", async () => {
    for (const id of ["maya", "kai"] as const) {
      const settings: StudentSettings = { id, level: "supported" };
      const teaching = Array.from({ length: 600 }, (_, index) => `The teacher's example ${index} shows a rule connecting two quantities under one stated condition.`).find(text => shouldSurfaceMisconception(text, settings))!;
      const replies: string[] = [];
      const client = new MockClient({ lesson: mockLesson("A new mechanism", settings), tokenProvider: async () => { throw new Error("offline"); }, onServerEvent: event => { if (event.type === "response.output_audio_transcript.done") replies.push(String(event.transcript)); } });
      await client.connect(); await client.sendUserText(teaching);
      expect(replies.at(-1)).toContain(id === "maya" ? "same way in every situation" : "conditions changes");
      await client.sendUserText("No, that conclusion only applies under the condition I stated.");
      expect(replies.at(-1)).toContain(id === "maya" ? "fixes the picture" : "resolves the gap");
      await client.sendUserText(teaching);
      expect(replies.at(-1)).not.toContain(id === "maya" ? "same way in every situation" : "conditions changes");
      await client.close();
    }
  });
});
