# Domain knowledge

Non-obvious facts about claudops, for Claude: decisions and their reasons,
pitfalls, constraints that cost time to find out. One fact per file. Read this
index before starting a ticket; add to it whenever you learn something that would
have saved you time.

This is not user documentation -- that is [wiki/](../wiki/README.md). It is also
not a restatement of what the code plainly says.

Format and maintenance rules: skill `domain-knowledge`.

## Entries

- [Terminal streaming rides on tmux, not on an application buffer](terminal-streaming-via-tmux.md) - why reconnect and scrollback are free
- [Docker cannot kill an exec, so the terminal has to ask it to leave](docker-cannot-kill-an-exec.md) - closing the stream leaves the tmux client attached
- [A WebSocket route must pause the socket while it is still setting up](websocket-frames-need-a-listener.md) - frames sent before the handler exists are dropped
- [The ws send callback reports success as `null`, not `undefined`](ws-send-callback-gets-null.md) - the backpressure resume that never ran
- [The Claude auth token is an OAuth token, never an API key](auth-token-handling.md) - an ANTHROPIC_API_KEY overrides the subscription
- [Git tokens reach the container through a credential helper](git-token-via-credential-helper.md) - keeps them out of .git/config and logs
- [The container user is UID 1001, not 1000](container-user-uid-1001.md) - the node image already took 1000
- [tmux attach through docker exec needs TERM in the image](tmux-attach-needs-term.md) - fails with "terminal does not support clear"
- [tmux writes an underscore for every multi-byte character unless the client says UTF-8](tmux-needs-a-utf8-client.md) - Claude's TUI arrives as rows of "_"
- [A failed clone must not kill the container](failed-clone-must-not-abort.md) - a dead container is unreachable for diagnosis
- [Project environments are prebuilt images, not devcontainer features](project-images-not-devcontainer-features.md) - devcontainer features have no layer caching
- [The dev host is Windows, the target is Linux](windows-dev-host-linux-target.md) - line endings and MSYS path rewriting bite
- [Verify line endings with cat-file and byte counting, not with grep](verifying-line-endings.md) - grep and git show both lie about CR
- [Git Bash loses a trailing CR from a command substitution](git-bash-drops-a-trailing-cr.md) - the keystroke that never submits
- [The database holds identity, Docker holds state](database-holds-identity-docker-holds-state.md) - why there is no status column and why the row is written first
- [Fastify silently strips unknown request fields unless told not to](fastify-strips-unknown-fields.md) - additionalProperties: false alone answers 201
- [pnpm 10 blocks install scripts, which native modules need](pnpm-blocks-native-build-scripts.md) - better-sqlite3 fails at require time, not at install
- [The browser must send keystrokes as binary frames, never as text](terminal-input-must-be-binary.md) - a pasted JSON object would be read as a control message
- [Hand xterm the raw bytes of a frame, never a per-frame decoded string](xterm-write-bytes-not-strings.md) - a multi-byte character can be split across two frames
- [The web UI routes in the hash because the path belongs to the API](spa-hash-routing-avoids-the-api-namespace.md) - `/instances/<id>` is already a REST resource
- [Playwright's browser is a separate install step](playwright-browsers-need-an-explicit-install.md) - pnpm 10 blocks the postinstall that fetches it
- [A project's PAT is encrypted at rest, an instance's is not stored at all](project-pat-encrypted-at-rest.md) - why the one secret in the database is allowed there
- [Foreign keys are off unless openDatabase opened the file](sqlite-fk-needs-the-pragma-in-tests.md) - the delete a test sees succeed and production refuses
- [In WAL mode a fresh row is in the -wal file, not in the .db](wal-keeps-fresh-rows-out-of-the-db-file.md) - the grep that could not fail
