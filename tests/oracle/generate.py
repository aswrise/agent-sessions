#!/usr/bin/env python3
"""Generate sanitized parity output from the pre-migration Python entrypoint."""

import hashlib
import importlib.util
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from importlib.machinery import SourceFileLoader
from pathlib import Path


ROOT = Path(__file__).parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "home"
LOADER = SourceFileLoader("sessions_oracle", str(ROOT / "sessions"))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
sessions = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(sessions)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def prepare(home):
    shutil.copytree(FIXTURE, home, dirs_exist_ok=True)
    for path in home.rglob("*.jsonl"):
        if path.name != "small.jsonl":
            with path.open("a") as fh:
                fh.write(json.dumps({"padding": "x" * 2200}) + "\n")
    timestamps = {"claude-a.jsonl": 100, "rollout-codex-b.jsonl": 200, "pi-c.jsonl": 300}
    for path in home.rglob("*.jsonl"):
        stamp = timestamps.get(path.name, 50)
        os.utime(path, (stamp, stamp))
    rows = json.loads((home / ".codex/state-rows.json").read_text())
    with sqlite3.connect(home / ".codex/state_5.sqlite") as db:
        db.execute("CREATE TABLE threads (id, title, first_user_message)")
        db.executemany("INSERT INTO threads VALUES (?, ?, ?)", rows)


def configure(home):
    sessions.CLAUDE_DIR = home / ".claude/projects"
    sessions.CODEX_DIR = home / ".codex/sessions"
    sessions.CODEX_INDEX_FILE = home / ".codex/session_index.jsonl"
    sessions.CODEX_STATE_FILE = home / ".codex/state_5.sqlite"
    sessions.PI_DIR = home / ".pi/agent/sessions"
    sessions.DATA_DIR = home / ".local/share/session-snapshots"
    sessions.STARS_FILE = sessions.DATA_DIR / "stars.json"
    sessions._file_cache.clear()


def main():
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"
        prepare(home)
        configure(home)
        rows = sessions.build_index()
        output = {
            "sessions": rows,
            "transcripts": {},
            "resume": {},
        }
        for row in rows:
            messages = sessions.transcript_messages(row["tool"], row["id"])
            output["transcripts"][row["id"]] = [
                {"role": message["role"], "timestamp": message["timestamp"],
                 "text_sha256": digest(message["text"])}
                for message in messages
            ]
            output["resume"][row["id"]] = sessions.resume_cmd(
                row["tool"], row["id"], row["cwd"], row["model"])
        print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
