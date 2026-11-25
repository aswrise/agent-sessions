# Agent Sessions

This context describes local agent conversation history across CLI tools.

## Language

**Session**:
A stored conversation from one local agent tool, identified by a session id and tied to its original working directory.
_Avoid_: Thread, chat

**Transcript**:
The readable user and assistant message flow inside a Session.
_Avoid_: Raw events, debug log

## Architecture

`SessionCatalog` is the deep module shared by the CLI and HTTP server. It owns
Claude, Codex, pi, and agy adapters, normalized Session/Transcript values, file
metadata caching, marks, search, and tool-specific rename behavior. The Vue
application only consumes validated JSON contracts and owns presentation state.
Source Session files and Codex SQLite inputs remain read-only.

The release artifact embeds the Vite output into one Bun executable. Explicit
mark and rename operations are the only catalog writes. Dashboard lifecycle
state is outside the executable and is validated by pid, port, and a
nonce-bound GET health check.
