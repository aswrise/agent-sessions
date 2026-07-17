# ADR 0002: Derived Session Lineage Index

## Status

Accepted

## Context

Cross-Session work often passes a Markdown or HTML Artifact from one Session to another. Transcript values intentionally omit tool results, so the existing normalized Transcript cannot prove that an Artifact write succeeded. Recomputing this relationship from every source JSONL on each query would make the dashboard slow as history grows.

The source Session files and Codex state database must remain read-only.

## Decision

`SessionCatalog` remains the sole application boundary used by CLI and HTTP consumers. It owns an internal `LineageIndex`, which extracts successful tool-specific writes and effective task inputs from Session JSONL and stores only derived facts and edges in `lineage.sqlite` under the existing application data directory.

The index is a disposable cache, not source data. A versioned file signature invalidates old extraction results. Global refresh and single-Session lookup use the same index; unchanged Session files are not reparsed. A single-Session lookup traverses edges in both directions to return the full connected component.

User-added Manual Lineage is authoritative application data rather than a derived fact. `SessionCatalog` stores it atomically in `manual-lineages.json` beside the existing marks file, then merges it with derived edges for traversal and presentation. Rebuilding or deleting `lineage.sqlite` therefore cannot remove a manual relation.

At the current data volume, changed Session facts are updated incrementally while the small edge set is rebuilt in one transaction. We will introduce affected-path edge updates only if this rebuild becomes measurably slow.

## Consequences

- Claude, Codex, and pi raw event differences remain hidden behind `SessionCatalog`; CLI, HTTP, and Vue consume normalized Lineage contracts.
- Source Session files and upstream SQLite databases remain read-only.
- The application data directory gains a writable, rebuildable SQLite cache and its WAL files.
- The application data directory also contains `manual-lineages.json`; unlike the SQLite cache, this file must be preserved across index rebuilds.
- Extraction-rule changes must increment the index version.
