"""Tests use fake rooms/provider responses; they never allocate a live avatar."""
import asyncio
import base64
import contextlib
import io
import json
import os
import signal
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

with patch.dict(os.environ, {"BOSON_API_KEY": "test-only-key"}):
    import agent

CONFIG = json.dumps({"type": "session.update", "session": {"model": "higgs-realtime", "tools": []}})

class FakeRoom:
    def __init__(self):
        self.connect = AsyncMock()
        self.disconnect = AsyncMock()
        self.remote_participants = {}
    def on(self, _name):
        return lambda callback: callback

class FakeOutput:
    def __init__(self):
        self.handlers = {}
        self.capture_frame = AsyncMock()
        self.flush = MagicMock()
        self.clear_buffer = MagicMock(side_effect=self.clear)
    def on(self, name):
        def register(callback): self.handlers[name] = callback; return callback
        return register
    def clear(self):
        self.handlers["playback_finished"](SimpleNamespace(playback_position=0.12, interrupted=True))

class FakeSocket:
    def __init__(self, events): self.events = events; self.send = AsyncMock()
    async def __aenter__(self): return self
    async def __aexit__(self, *_args): pass
    def __aiter__(self):
        async def stream():
            for event in self.events:
                await asyncio.sleep(0)
                yield json.dumps(event)
            await asyncio.sleep(0)
        return stream()

class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_student_speech_is_reviewed_before_tagged_synthesis(self):
        pending = {}
        def reviewer(kind, **data):
            self.assertEqual(kind, "speech_review")
            self.assertEqual(data["text"], "An untaught expert answer")
            pending[data["request_id"]].set_result("Could you show me a simple example?")
        approved = await agent.review_student_speech("An untaught expert answer", "r1", pending, reviewer)
        self.assertEqual(approved, "Could you show me a simple example?")
        self.assertEqual(pending, {})

    async def test_student_speech_review_fails_closed_on_timeout(self):
        pending = {}
        approved = await agent.review_student_speech("An untaught answer", "r2", pending, lambda *_args, **_kwargs: None, timeout=0.001)
        self.assertNotIn("untaught answer", approved)
        self.assertIn("simple example", approved)
        self.assertEqual(pending, {})

    def test_fact_logging_responses_and_immediate_followups_are_neutral(self):
        tool_response = {"response": {"output": [
            {"type": "function_call", "name": "update_understanding", "call_id": "fact-1"},
        ]}}
        self.assertTrue(agent.response_logs_fact(tool_response))
        self.assertTrue(agent.response_logs_fact({
            "type": "response.function_call_arguments.done",
            "name": "update_understanding",
        }))
        self.assertFalse(agent.should_apply_emotion(agent.response_logs_fact(tool_response)))
        self.assertTrue(agent.should_apply_emotion(False))

    def test_tagged_emotion_is_selected_for_half_of_eligible_replies(self):
        self.assertIsNone(agent.choose_speech_emotion(lambda: 0.5))
        with patch.object(agent.random, "choices", return_value=["anger"]) as choices:
            self.assertEqual(agent.choose_speech_emotion(lambda: 0.49), "anger")
        choices.assert_called_once()

    def setUp(self):
        self.room = FakeRoom()
        self.post = MagicMock(return_value=SimpleNamespace(ok=True, json=lambda: {"id": "test-session"}))
        self.delete = MagicMock()
        self.logs = io.StringIO()
        self.context = contextlib.ExitStack()
        self.context.enter_context(patch.dict(os.environ, {"BOSON_REALTIME_MODEL": "higgs-realtime", "LIVEKIT_URL": "wss://test.livekit.cloud"}))
        self.context.enter_context(patch.object(agent, "MANAGED", False))
        self.context.enter_context(patch.object(agent.Path, "read_text", return_value=CONFIG))
        self.context.enter_context(patch.object(agent, "livekit_token", return_value="test-room-token"))
        self.context.enter_context(patch.object(agent.rtc, "Room", return_value=self.room))
        self.context.enter_context(patch.object(agent.requests, "post", self.post))
        self.context.enter_context(patch.object(agent.requests, "delete", self.delete))
        self.context.enter_context(contextlib.redirect_stdout(self.logs))
    def tearDown(self): self.context.close()
    async def run_main(self):
        with patch.object(asyncio.get_running_loop(), "add_signal_handler"):
            await agent.main()
    async def test_windows_signal_handlers_fall_back_to_signal_module(self):
        loop = asyncio.get_running_loop()
        stop = asyncio.Event()
        handlers = []
        with patch.object(loop, "add_signal_handler", side_effect=NotImplementedError), \
             patch.object(agent.signal, "signal", side_effect=lambda _sig, handler: handlers.append(handler)):
            agent.install_stop_handlers(loop, stop)
        self.assertEqual(len(handlers), 2)
        handlers[0](signal.SIGINT, None)
        await asyncio.sleep(0)
        self.assertTrue(stop.is_set())
    async def test_microphone_audio_is_forwarded_while_avatar_speaks_for_native_barge_in(self):
        ws = SimpleNamespace(send=AsyncMock())
        frame = SimpleNamespace(data=b"\x01\x02")
        await agent.send_microphone_frame(ws, frame)
        ws.send.assert_awaited_once_with(json.dumps({
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(frame.data).decode(),
        }))
    async def test_releases_created_avatar_even_when_room_connection_fails(self):
        self.room.connect.side_effect = RuntimeError("room refused")
        with self.assertRaises(RuntimeError): await self.run_main()
        self.delete.assert_called_once()
        self.assertTrue(self.delete.call_args.args[0].endswith("/avatar/sessions/test-session"))
        self.room.disconnect.assert_awaited_once()
    def test_capacity_message_includes_provider_retry_delay(self):
        response = SimpleNamespace(status_code=429, headers={"Retry-After": "30"}, json=lambda: {"error": {"code": "capacity_exhausted"}})
        self.assertIn("Retry after 30 seconds", agent.avatar_session_failure(response))

    def test_billing_refusal_is_not_reported_as_temporary_capacity(self):
        response = SimpleNamespace(status_code=429, json=lambda: {"error": {"type": "insufficient_quota"}})
        message = agent.avatar_session_failure(response)
        self.assertIn("account credit", message)
        self.assertNotIn("capacity is currently full", message)

    async def test_capacity_refusal_does_not_retry_or_join_a_room(self):
        self.post.return_value = SimpleNamespace(ok=False, status_code=429, json=lambda: {"error": {"code": "capacity_exhausted"}})
        await self.run_main()
        self.post.assert_called_once(); self.delete.assert_not_called(); self.room.connect.assert_not_called()
        self.assertIn("capacity_exhausted", self.logs.getvalue())
        self.assertIn("capacity is currently full", self.logs.getvalue())
        self.assertIn("voice + photo", self.logs.getvalue())
        self.assertNotIn("Check account access, credit", self.logs.getvalue())
        self.assertNotIn("test-only-key", self.logs.getvalue())
    async def test_account_avatar_id_uses_the_same_official_livekit_session_request(self):
        self.room.connect.side_effect = RuntimeError("stop after provider request")
        with patch.object(agent, "AVATAR_ID", "owned_alex_test"):
            with self.assertRaises(RuntimeError): await self.run_main()
        payload = self.post.call_args.kwargs["json"]
        self.assertEqual(payload["avatar_id"], "owned_alex_test")
        self.assertEqual(payload["transport"]["type"], "livekit")
        self.assertEqual(payload["transport"]["publisher_identity"], "agent")
        self.assertNotIn("ref_image", payload)
        self.assertTrue(self.post.call_args.args[0].endswith("/v1/avatar/sessions"))
        self.delete.assert_called_once()
    async def test_sdk_interruption_clears_avatar_and_truncates_to_heard_audio(self):
        output = FakeOutput()
        ws = FakeSocket([
            {"type": "session.created"},
            {"type": "response.output_audio.delta", "item_id": "alex-1", "delta": base64.b64encode(b"\0\0\0\0").decode()},
            {"type": "input_audio_buffer.speech_started"},
            {"type": "response.done", "response": {"status": "cancelled"}},
        ])
        with patch.object(agent, "DataStreamAudioOutput", return_value=output), patch.object(agent.websockets, "connect", return_value=ws):
            await self.run_main()
        output.capture_frame.assert_awaited_once(); output.clear_buffer.assert_called_once()
        sent = [json.loads(call.args[0]) for call in ws.send.call_args_list]
        self.assertIn({"type": "conversation.item.truncate", "item_id": "alex-1", "content_index": 0, "audio_end_ms": 120}, sent)
        self.delete.assert_called_once(); self.room.disconnect.assert_awaited_once()
        self.assertNotIn("response.output_audio.delta", self.logs.getvalue())

    async def test_visual_instruction_ack_does_not_reset_speaking_or_reannounce_ready(self):
        output = FakeOutput()
        ws = FakeSocket([
            {"type": "session.created"},
            {"type": "response.output_audio.delta", "item_id": "student-1", "delta": base64.b64encode(b"\0\0\0\0").decode()},
            {"type": "session.updated", "session": {"instructions": "new visual context"}},
            {"type": "response.done", "response": {"status": "completed"}},
        ])
        with patch.object(agent, "AUDIO_RENDERER", "realtime"), patch.object(agent, "DataStreamAudioOutput", return_value=output), patch.object(agent.websockets, "connect", return_value=ws):
            await self.run_main()
        messages = [json.loads(line) for line in self.logs.getvalue().splitlines() if line.startswith("{")]
        self.assertEqual(sum(m.get("kind") == "ready" for m in messages), 1)
        activities = [m.get("activity") for m in messages if m.get("kind") == "activity"]
        self.assertEqual(activities, ["listening", "speaking"])
        output.clear_buffer.assert_not_called()

if __name__ == "__main__": unittest.main()
