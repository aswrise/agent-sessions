# Python parity oracle

`catalog.json` is the checked output captured from the Python implementation
immediately before cutover. It contains normalized metadata and Transcript text
hashes only. The generator was removed with the Python implementation; Bun tests
continue to compare `SessionCatalog` results against this immutable oracle.
