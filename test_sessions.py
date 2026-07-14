import importlib.util
from importlib.machinery import SourceFileLoader
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock


LOADER = SourceFileLoader("sessions_module", str(Path(__file__).with_name("sessions")))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
sessions = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(sessions)


class SessionsTest(unittest.TestCase):
    def test_build_index_reuses_file_metadata_but_refreshes_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            path.write_text("{}\n" + " " * sessions.MIN_SIZE)
            names = {"old-session": "旧名称"}
            calls = {"parse": 0, "tail": 0}

            def parse(_path):
                calls["parse"] += 1
                return "old-session", "/tmp/project", "首条消息", 1

            def tail(_path, _tool):
                calls["tail"] += 1
                return "model"

            sessions._file_cache.clear()
            with (mock.patch.object(sessions, "iter_files",
                                    side_effect=lambda only=None: iter([("claude", path)])),
                  mock.patch.object(sessions, "load_claude_names", side_effect=lambda: names.copy()),
                  mock.patch.object(sessions, "load_codex_names", return_value={}),
                  mock.patch.object(sessions, "load_stars", return_value={}),
                  mock.patch.dict(sessions.PARSERS, {"claude": parse}),
                  mock.patch.object(sessions, "tail_model", side_effect=tail)):
                self.assertEqual(sessions.build_index()[0]["name"], "旧名称")
                names["old-session"] = "新名称"
                self.assertEqual(sessions.build_index()[0]["name"], "新名称")
                self.assertEqual(calls, {"parse": 1, "tail": 1})

                path.write_text(path.read_text() + "\n")
                sessions.build_index()
                self.assertEqual(calls, {"parse": 2, "tail": 2})

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

    def test_iter_files_skips_codex_subagents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "2026" / "07" / "14"
            root.mkdir(parents=True)
            normal = root / "rollout-normal.jsonl"
            child = root / "rollout-child.jsonl"
            normal.write_text(json.dumps({"payload": {"id": "normal"}}) + "\n")
            child.write_text(json.dumps({"payload": {
                "id": "child", "thread_source": "subagent"}}) + "\n")
            with mock.patch.object(sessions, "CODEX_DIR", Path(tmp)):
                self.assertEqual(list(sessions.iter_files("codex")),
                                 [("codex", normal)])

    def test_parse_codex_ignores_malformed_session_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout.jsonl"
            for raw in ("[]\n", '{"payload": null}\n', '{"payload": []}\n'):
                path.write_text(raw)
                self.assertIsNone(sessions.parse_codex(path))
                self.assertFalse(sessions.is_codex_subagent(path))

    def test_preview_keeps_pointer_and_scroll(self):
        self.assertIn("overscroll-behavior:contain", sessions.DASH_TEMPLATE)
        self.assertIn("tip.addEventListener('mouseenter',cancelTipHide)", sessions.DASH_TEMPLATE)
        self.assertIn("if(e.target!==tip)hideTip()", sessions.DASH_TEMPLATE)

    def test_dashboard_paginates_rows_in_the_browser(self):
        self.assertIn("const PAGE_SIZE=100;", sessions.DASH_TEMPLATE)
        self.assertIn('id="pager"', sessions.DASH_TEMPLATE)
        self.assertIn('aria-label="分页"', sessions.DASH_TEMPLATE)
        self.assertIn("rows.slice(start,start+PAGE_SIZE)", sessions.DASH_TEMPLATE)


if __name__ == "__main__":
    unittest.main()
