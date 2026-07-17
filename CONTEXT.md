# Agent Sessions

This context describes local agent conversation history across CLI tools.

## Language

**Session**:
A stored conversation from one local agent tool, identified by a session id and tied to its original working directory.
_Avoid_: Thread, chat

**Transcript**:
The readable user and assistant message flow inside a Session.
_Avoid_: Raw events, debug log

**Artifact**:
An absolute-path Markdown or HTML file successfully written during a Session and later referenced by another Session.

**Lineage**:
An upstream/downstream relationship between Sessions, either inferred from an Artifact transfer or explicitly added by a user.
_Avoid_: Thread group, task id

**Manual Lineage**:
An explicit upstream/downstream relationship added by a user when Artifact-based inference misses the handoff.

## Architecture

`SessionCatalog` is the deep module shared by the CLI and HTTP server. It owns
Claude, Codex, and pi adapters, normalized Session/Transcript values, file
metadata caching, marks, search, and tool-specific rename behavior. The Vue
application only consumes validated JSON contracts and owns presentation state.
The catalog also owns the persistent derived Lineage index and explicit Manual Lineage data; source Session files
and Codex SQLite inputs remain read-only. Manual Lineage is stored separately from the disposable derived index.

The release artifact embeds the Vite output into one Bun executable. Explicit
mark, rename, Manual Lineage, and derived-index operations are the only catalog
writes. Dashboard lifecycle state is outside the executable and is validated by
pid, port, and a nonce-bound GET health check.
