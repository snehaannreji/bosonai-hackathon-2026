# Earned student knowledge

TeachBack now separates a student-facing memory from private instructor
assessment. A new lesson starts with no subject facts at every response-style
setting and learning pace. A quick learner reasons faster about taught ideas;
it does not start with more subject knowledge. There is no cross-lesson memory
or automatic import of old concepts.

## Why the student previously sounded like an expert

- Live lesson planning explicitly generated a starting misconception and the
  initial dashboard map treated it as prior belief. Diagnostic voice/mock paths
  also seeded a gradient misconception.
- The model got an instruction to start blank, but subsequent learning-tool
  outputs gave generic personality guidance, not an explicit list of earned
  facts and permitted terms.
- Native model training remained available to generation. Neither responses
  nor AI drawing operations had an application-level knowledge check.
- The existing private assessor was logically separate, and uploaded references
  were already excluded from the student prompt. That separation is retained;
  it was not sufficient by itself to constrain student generation.

The planner now requests empty initial beliefs, the server discards unsolicited
ones, all initial concepts are unknown, and the diagnostic/mock seeded hunches
are removed. Existing styles, voices, emotions and interruption handling remain.

## State and authority

`StudentKnowledge` in `src/state/studentKnowledge.ts` owns the student projection.
It keeps lesson-local teacher turns, facts with stable source IDs, permitted
vocabulary, per-concept stages, tentative inferences, unresolved questions and
links between ideas sharing taught terms. The separate `TopicKnowledgeTracker`
and Boson assessor retain the instructor's labels, criteria, accuracy reviews,
reference material and corrections.

`createKnowledgeTracker` connects the two. Transcribed teacher explanations and
concrete drawing instructions become provisional student facts immediately,
even if the model has not called `update_understanding` or the evaluator is
unavailable. Assessment updates refine private grading without removing those
teacher-grounded facts. The student projection takes only conversation evidence
whose source exists in its observed teacher transcript. It uses the actual teacher words, never an
assessor paraphrase. Reference-note facts, assessment reasons, ground-truth
corrections, and untaught rubric labels are excluded. Wrong teacher statements
therefore become provisional beliefs even when the instructor assessor flags
them. Their corrections remain instructor-only. A source citation is evidence
of teaching, not proof that the claim is true.

Questions, bare requests for named diagrams, topic announcements, reassurance
and role-change commands do not independently add facts. Concrete instructions
such as “draw circles for nodes and connect them with lines” do explain a visual
structure and can be used immediately. A leading expert question invented by
the student plus an ungrounded “yes” cannot bootstrap new expertise. Contextual
answers to grounded questions can be retained as working beliefs. Declarative
sentence filtering is intentionally conservative and currently English-oriented.

Internal concepts begin `unknown`. The student receives only concepts supported
by teacher evidence, so the private list of future topics cannot become its
question agenda. A taught concept name is used only when its words occurred in
the teaching; otherwise the name comes from the teacher's own statement.

The student stages are distinct from instructor rubric completion:

- **Unknown:** no accepted subject facts; ask a basic definition or example.
- **Introduced:** an initial teacher claim is available, even if incomplete or
  inaccurate; restate it tentatively and ask for a missing detail.
- **Partial:** multiple facts can be connected or some explanation criteria were
  met; use small grounded inferences and applications.
- **Understood:** the teacher has confirmed a previously grounded teach-back.
  This is a simulation milestone, not an independent proof of general mastery.

Time, confidence and a reference answer never unlock facts. The dashboard shows
the student-memory stage and fact count separately from instructor verification.

## Conversation and response checks

Both live paths include current student state in initial session instructions
and in learning-tool feedback. Silent instruction updates share the existing
acknowledged `VisualContextChannel` with Gemini, preserving the latest board
context instead of overwriting it. These updates use supported `session.update`
messages; they do not restart audio or create turns.

The application-defined `prepare_response` function checks proposed speech and
teacher fact IDs. The prompt requires this before substantive speech. The
validator uses ordinary conversational vocabulary, terms actually taught,
private rubric vocabulary for detection, and formula checks. It allows basic
questions about names mentioned by the teacher, but does not treat those names
as understood facts. Unsupported proposals return a short varied clarification
as `approved_text`, with no second evaluator/model call. The student must speak
that approved text. Teacher-confirmed grounded responses can advance its state;
student-generated inferences stay tentative rather than becoming facts.

Tagged TTS has an additional enforced check of the complete utterance before
synthesis. Direct voice checks locally; the managed Python avatar asks the Node
bridge for approval over the existing application IPC before feeding Higgs TTS
into the synchronized avatar output. On timeout it asks for a simple example.
Interrupted review work cannot enqueue late speech. The tagged transcript uses
the reviewed words rather than showing rejected transcript deltas.

**Native realtime audio is streaming.** Its transcript can arrive after sound has
played. This path has the earned-state prompt, proposed-response tool and
post-transcript monitoring/permission refresh, but cannot guarantee that an
ignored guard never reaches the listener. Blocking every native utterance before
playback would require buffering or changing the audio-generation architecture.
This implementation preserves native low-latency audio and avatar synchronization.
Use tagged TTS when deterministic pre-speech checking is needed.

The lexical checker is a practical safeguard, not a semantic proof. It can reject
unfamiliar everyday paraphrases, especially in non-English lessons, and can miss
an unsupported assertion composed entirely of already allowed words. It does not
retrain or remove knowledge from the pretrained model. Live behavior still needs
evaluation with a credentialed Boson session.

## Whiteboard and drawing

The existing drawing tools remain registered in both live modes. Mutating calls
require a short `intent`. `evidence_ids` are optional: the application attaches
current teacher facts when citations are omitted or empty, and accepts either
fact IDs or their teacher source IDs. Explicit forged IDs produce a recoverable
argument error rather than claiming the student lacks knowledge. The handler
checks intent and labels for untaught technical terms separately from speech
rules, allowing drawing verbs, variable names and multiple labels. It requires
supporting mathematical teaching for polynomial plots. Only then
does it strip the provenance fields and invoke the existing atomic drawing
handler. Inspection (`get_whiteboard`) remains available without subject knowledge.
Stable IDs, revisions, ownership, teacher edits, undo/redo and tablet sync remain.

Drawing readiness is explicit in the current student state. Introduced or partial
understanding is sufficient: the model should draw the explained parts and omit
untaught details rather than waiting for mastery or instructor approval.

The model still constructs arbitrary diagrams from primitives and sampled paths.
There is no expert diagram library unlocked by topic name. A fresh “draw a neural
network with backpropagation” request is blocked. After teaching connected nodes
and lines, a basic network becomes available; backpropagation labels remain
blocked until taught.

Geometric meaning cannot be proven from arbitrary coordinates. A model could
misdescribe the intent of an otherwise valid path. Intent/provenance and label
checks constrain it without claiming a full visual-semantic verifier.

Gemini continues to report literal visible shapes, directions, colors and text;
its existing prompt prohibits solving. Whiteboard observations are visual data,
not evidence that a concept was taught. AI-only edits still bypass redundant
Gemini calls and never become new teacher instructions.

## Try A–H

Begin a new live lesson after refreshing the app; an already-running model
conversation retains its prior conversation history.

1. **A:** Choose “Neural networks” and say “I'm going to teach you neural networks.”
   Expect a basic meaning/example question, no backpropagation lecture.
2. **B:** Ask for the derivative of sigmoid before teaching it. Expect a request
   for explanation, not the pretrained formula.
3. **C/D:** Teach gradient descent as moving downhill, define loss, then explain
   that the gradient points where loss increases. The student may now infer an
   opposite direction tentatively. It must not explain an untaught learning rate.
4. **E:** Teach a false direction. The student can adopt the false claim while
   instructor verification privately flags it; no reference correction is fed
   into student memory.
5. **F:** In a fresh lesson request a network with backpropagation. Expect a
   teaching request and no board mutation.
6. **G:** Teach that nodes can be circles joined by lines, then request that
   diagram. Expect drawing calls citing those teacher facts. Teach new mechanisms
   before requesting their labels or shapes.
7. **H:** Start an unrelated lesson. The memory stage returns to unknown and no
   previous subject facts or vocabulary are retained.

Automated tests exercise these state transitions and guards, actual fake-socket
voice tool dispatch, private-answer isolation, avatar bridge checks, board/context
merging, complete guarded transcripts and Python pre-synthesis approval/timeout.
They test application behavior, not live model compliance or spoken wording.

## Files changed for this behavior

- `src/state/studentKnowledge.ts`: student memory, projection, provenance,
  response/drawing checks, schemas and knowledge policy.
- `src/state/createKnowledgeTracker.ts`, `topicKnowledge.ts`, `knowledge.ts`:
  separate student projection, empty initial maps and safe feedback.
- `server/lessons.ts`: zero-belief planning and server enforcement.
- `src/realtime/sessionConfig.ts`: earned-state instructions and guarded tools.
- `src/realtime/RealtimeClient.ts`, `avatarToolBridge.ts`, `LiveAvatarClient.ts`,
  `MockClient.ts`: state delivery, tool checks and guarded speech paths.
- `server/avatarSessions.ts`, `avatar/agent.py`: avatar student-state events and
  pre-synthesis review on the existing IPC transport.
- `src/whiteboard/contextChannel.ts`: serialized knowledge/vision instruction
  updates without losing either context.
- `src/App.tsx`, `src/ui/LearningMap.tsx`: separate student-memory status.
- `src/state/transcriptStore.ts`: complete reviewed transcripts without deltas.
- `tsconfig.server.json`: shared student module inclusion.
- Tests in `test/studentKnowledge.test.ts`, `realtimeClient.test.ts`,
  `avatarToolBridge.test.ts`, `visualContext.test.ts`, `knowledge.test.ts`,
  `mockClient.test.ts`, `drawingTools.test.ts`, `transcriptStore.test.ts`, and
  `avatar/test_agent.py`. Drawing implementation from the preceding task remains.
