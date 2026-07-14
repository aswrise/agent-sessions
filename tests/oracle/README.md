# Python parity oracle

Run before the cutover while the Python entrypoint is present:

```bash
python3 tests/oracle/generate.py > tests/oracle/catalog.json
python3 -m unittest test_sessions.py
```

The checked output contains normalized metadata and Transcript text hashes only.
