# Student drawing on TeachBack's shared board

The existing board is a 640×480 HTML Canvas, rendered from `Mark[]` held in
`WhiteboardPanel` refs. It is not tldraw or an image-based diagram library. Student
commands create the same editable records as teacher input. The existing Move,
Undo, Redo and eraser controls work on student drawings. Text uses Canvas text
with Unicode math; it never renders model-generated HTML or SVG.

## Conversation flow

Both existing Boson paths advertise application-defined JSON Schema functions
through `session.update.session.tools`, receive
`response.function_call_arguments.done` (with the existing `response.done`
fallback), and return `conversation.item.create` / `function_call_output`.
Exactly one `response.create` follows a completed batch. No new Boson methods,
conversation restart, or alternate diagram model is involved.

Direct voice mode calls the mounted board handler. Avatar mode's existing
server-side `AvatarToolBridge` sends a transient SSE `drawing_request` through
`DrawingRelay`. The browser applies it to the visible board and posts its result
to the existing avatar lesson's `drawing-result` endpoint. The bridge waits for
that acknowledgement before continuing speech. Requests are not stored in SSE
history. IDs are deduplicated; avatar commands execute serially. An interrupted
or failed response does not start another spoken response or apply queued
commands. Already applied atomic edits remain visible after interruption.

`get_whiteboard` returns the actual current revision, IDs, ownership, styles,
text and points. `draw_shapes`, `draw_text`, and `draw_path` add objects with
model-chosen IDs. `update_shapes` patches specified fields; `erase_shapes`
removes specified student objects. Updates/deletions require the current board
revision to reject stale corrections after manual teacher edits. Teacher marks
are never targets of those tools. Existing IDs survive moves and tablet sync.

`plot_function` samples a polynomial using deterministic Horner evaluation into
161 points. Coefficients are ascending: `[0,0,1]` means x². General graphs,
flowcharts, networks, and illustrations are composed dynamically from paths,
primitives and text; there is no predefined diagram catalog or code execution.

## Coordinates and placement

All tool coordinates are normalized to the visible board: `(0,0)` is top left,
`(1,1)` bottom right, positive y points down. Shapes specify two endpoints or
opposite bounding corners; text specifies one anchor; paths specify 2–512 points.
The board converts coordinates to its native 640×480 space. CSS resizing and
browser zoom use the existing pointer-to-canvas mapping. This board has no
independent pan/zoom camera. `get_whiteboard` allows the student to calculate
positions relative to current objects, inspect occupied space, and identify an
arrow for correction. Placement planning is model-directed; there is no
automatic collision solver (connections and axes intentionally overlap).

## Gemini and state synchronization

Teacher changes still use the existing event-driven Gemini snapshot pipeline.
Student-only changes send structured geometry in a silent, acknowledged visual
context update without requesting Gemini or creating a response. Pending teacher
analysis is retained and rerun on the combined board if a student edit invalidates
its frame. Structured records accompany normal visual context updates too, so
manual moves are visible to the student. When Gemini is unavailable/off, complete
teacher edits still share geometry; freehand semantic interpretation is absent.
Board contents are explicitly untrusted data, never teacher instructions or
evidence of learning.

Commands are atomic and validated against the advertised schemas' supported
fields and semantic constraints. Invalid batches do not partially modify state.
Limits: 40 objects per operation, 512 points per student path, 500 text characters,
300 board marks, and 32 drawing calls per teacher turn (including inspection).
Coordinates must be finite and inside the board; colors must be hex; stroke
width is 1–20. Polynomial coefficient count is at most 9. Curves outside the
chosen plot range are rejected so the student can choose a better range.
Commands return recoverable errors while a teacher pointer/tablet gesture is
active, after stale revisions, on timeout, or for malformed arguments.

## Try the demonstration

Student knowledge now starts empty. Before this drawing demonstration, teach
what a loss curve represents, what axes represent, and that a simple example is
`L(x) = x²`. Teach the gradient direction before requesting a descent arrow.
A drawing request alone does not teach those facts; the student should ask for
an explanation when they are missing. Teacher explanations unlock provisional drawing immediately, without waiting
for mastery or instructor grading. Drawing intent and any explicit source IDs
are checked by the live handlers before mutation; omitted citations are attached
automatically from current teacher facts.
See [earned student knowledge](earned-student-knowledge.md) for the A–H tests.

Start the server/client normally and begin a **live voice or avatar** lesson.
Use your selected student's configured name; the feature is not tied to Alex.
The board opens when the student uses a drawing tool. No new API key is needed.

1. “Draw a simple graph of a quadratic loss function.” Expect editable axes,
   labels and a U-shaped path. The student can use coefficients `[0,0,1]`, x range
   `[-2,2]`, y range `[0,4]`, and normalized plot corners `(0.15,0.15)`–`(0.85,0.8)`.
2. “Draw the direction you think gradient descent should move.” Expect a new
   arrow based on the student's simulated current belief. Whether the arrow is
   mistaken depends on the lesson's configured misconceptions and prior teaching.
3. “No, we need to move opposite the gradient. Reverse that arrow.” Expect a
   fresh board inspection and a targeted points update; axes, curve and teacher
   drawings remain intact. The spoken response follows the tool result.
4. “Now draw a simple neural network in the available space.” Expect nodes and
   connections built from primitives. For three hidden layers, ask explicitly;
   the model can build it with successive batches. Clear/move content yourself
   if the board is too crowded.
5. Select **Move**, drag a student shape, then say “What changed in your drawing?”
   Expect the manual edit to persist. A later recolor patch preserves its points;
   an update using the old revision is rejected. Undo/Redo also includes student
   operations. Pairing a tablet seeds it with the existing drawing.

Automated tests exercise A–E at the command/state layer, both Boson tool loops,
avatar browser acknowledgements, interruption, duplicate events, teacher
ownership, stale corrections, invalid input, tablet ID preservation, and Gemini
scheduling. They do not assert the live model's spoken wording or diagram quality.
A credentialed live microphone/avatar run is still needed to assess that behavior.

## Changed files

- `src/whiteboard/drawingTools.ts`: tool schemas, policy, validators, atomic
  operations, normalized snapshots and deterministic plots.
- `src/whiteboard/model.ts`, `board.ts`: shared mark identity/ownership types and
  board constants; existing Canvas rendering; bounded manual moves.
- `src/ui/WhiteboardPanel.tsx`, `TabletWhiteboard.tsx`, `src/App.tsx`: mounted
  drawing handler, undo/redo integration, teacher IDs, board opening and sync.
- `src/realtime/sessionConfig.ts`, `RealtimeClient.ts`, `avatarToolBridge.ts`,
  `LiveAvatarClient.ts`: registration, execution, structured results, duplicate
  suppression, interruption and per-turn budgets in existing conversations.
- `server/drawingRelay.ts`, `avatarSessions.ts`, `index.ts`: bounded browser
  acknowledgement relay and avatar geometry payload support.
- `src/whiteboard/observations.ts`, `visionPipeline.ts`: structured context,
  student-origin change handling and retained teacher analysis.
- `src/whiteboard/sharedBoard.ts`, `server/whiteboardSync.ts`: pairing seeds and
  validated identity metadata. `tsconfig.server.json` includes shared modules.
- Tests: `test/drawingTools.test.ts`, `server/drawingRelay.test.ts`,
  `test/realtimeClient.test.ts`, `test/liveAvatarClient.test.ts`,
  `test/visionPipeline.test.ts`, `server/whiteboardSync.test.ts`.

## Prototype limitations

Progressive tool calls appear immediately as small batches; there is no
artificial per-stroke animation. Teacher editing of student geometry uses the
existing Move/Undo/Redo/eraser controls, not a full vector inspector. Plots are
polynomial or explicit sampled paths; LaTeX rendering is not provided. Existing
tablet synchronization still uses full-board replacement: simultaneous edits
from multiple human devices can conflict; this is not a CRDT. Known active tablet
gestures block student writes, but a network race can still occur. Drawing is
not simulated in mock conversation mode. State is in-memory for the lesson.
Very dense boards approach the bounded structured-context payload limits and
may require clearing space. Model tool choice, layout, and the fidelity of its
simulated misconception require live evaluation with Boson.
