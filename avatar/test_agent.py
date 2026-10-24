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
    async def test_microphone_audio_is_not_forwarded_while_avatar_speaks(self):
        ws = SimpleNamespace(send=AsyncMock())
        frame = SimpleNamespace(data=b"\x01\x02")
        await agent.send_microphone_frame(ws, frame, avatar_speaking=True)
        ws.send.assert_not_awaited()
        await agent.send_microphone_frame(ws, frame, avatar_speaking=False)
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
    async def test_capacity_refusal_does_not_retry_or_join_a_room(self):
        self.post.return_value = SimpleNamespace(ok=False, status_code=429, json=lambda: {"error": {"code": "capacity_exhausted"}})
        await self.run_main()
        self.post.assert_called_once(); self.delete.assert_not_called(); self.room.connect.assert_not_called()
        self.assertIn("capacity_exhausted", self.logs.getvalue())
        self.assertNotIn("test-only-key", self.logs.getvalue())
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

if __name__ == "__main__": unittest.main()
