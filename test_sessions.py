import importlib.util
from importlib.machinery import SourceFileLoader
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


LOADER = SourceFileLoader("sessions_module", str(Path(__file__).with_name("sessions")))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
sessions = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(sessions)


class SessionsTest(unittest.TestCase):
    def test_codex_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            sessions.CODEX_INDEX_FILE = tmp / "session_index.jsonl"
            sessions.CODEX_STATE_FILE = tmp / "state.sqlite"
            sessions.CODEX_INDEX_FILE.write_text(
                json.dumps({"id": "explicit", "thread_name": "旧名称"}) + "\n" +
                json.dumps({"id": "explicit", "thread_name": "手动名称"}) + "\n")
            with sqlite3.connect(sessions.CODEX_STATE_FILE) as db:
                db.execute("CREATE TABLE threads (id, title, first_user_message)")
                db.executemany("INSERT INTO threads VALUES (?, ?, ?)", [
                    ("explicit", "自动名称", "首条消息"),
                    ("automatic", "自动名称", "另一条首条消息"),
                    ("unnamed", "原始首条消息", "原始首条消息"),
                ])
            self.assertEqual(sessions.load_codex_names(), {
                "explicit": "手动名称", "automatic": "自动名称"})

    def test_preview_keeps_pointer_and_scroll(self):
        self.assertIn("overscroll-behavior:contain", sessions.DASH_TEMPLATE)
        self.assertIn("tip.addEventListener('mouseenter',cancelTipHide)", sessions.DASH_TEMPLATE)
        self.assertIn("if(e.target!==tip)hideTip()", sessions.DASH_TEMPLATE)


if __name__ == "__main__":
    unittest.main()
