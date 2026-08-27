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
- [One template Dockerfile with `if`, not a generated Dockerfile per project](one-project-template-not-a-dockerfile-per-project.md) - what makes two projects share their layers
- [A failed image build answers HTTP 200 and reports the failure in the body](docker-build-errors-arrive-in-the-stream.md) - an unread stream makes every build look successful
- [The image status is the one piece of state the database is allowed to hold](project-image-state-lives-in-the-database.md) - a failed build leaves no Docker object to ask
- [Playwright's browsers have to be installed to a shared path](playwright-browsers-need-a-shared-path.md) - root installs them, `claude` has to read them
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
- [`docker rm -v` is only half of a delete](delete-must-sweep-volumes-by-label.md) - why the label sweep exists although nothing creates a volume
- [A memory limit without a swap limit is a memory limit of twice that](memory-limit-needs-a-swap-limit.md) - the instance that pages the NUC instead of dying
- [better-sqlite3 13 segfaults on Node below 22.14](better-sqlite3-needs-node-22-14.md) - a test gate that is red for no reason of yours
- [A free port on Windows can still be a forbidden one](windows-reserves-tcp-port-ranges.md) - EACCES on a port nothing is listening on
- [iptables needs root, not just NET_ADMIN](iptables-needs-root-not-just-net-admin.md) - why one sudoers entry exists in the image
- [A firewall script must fail closed, and say so when it cannot](a-firewall-script-must-fail-closed.md) - the Anthropic reference fails open while reporting failure
- [The firewall's re-run guard is an iptables chain, not a file](firewall-sentinel-is-an-iptables-chain.md) - a marker in /run refuses after a restart and permits after a flush
- [Do not whitelist the docker bridge](do-not-whitelist-the-docker-bridge.md) - the reference's host /24 is the claudops API and every neighbour
- [Reading /proc/1/environ in a container needs CAP_SYS_PTRACE](proc-environ-needs-cap-sys-ptrace.md) - the whitelist entry that silently never arrived
- [A browser WebSocket cannot set a header, so the credential is a cookie](a-browser-websocket-cannot-set-a-header.md) - and a root onRequest hook does gate the upgrade
- [A hook that refuses a WebSocket upgrade has to destroy the socket itself](refusing-a-websocket-upgrade-leaks-its-socket.md) - otherwise the server never shuts down again
- [The session cookie is stateless, so logout is client-side only](the-session-cookie-is-stateless.md) - what rotating the login secret actually does
- [Claude Code asks three questions on a first start, and a container is always a first start](claude-onboarding-must-be-pre-seeded.md) - the theme picker is not a login, and a clone is its own trust root
- [A container that withholds Claude may be hitting GitHub's rate limit, not a firewall bug](github-meta-is-rate-limited.md) - 60 `/meta` calls an hour, one per container start
- [`playwright.request.newContext()` inherits `use.storageState`, so an "anonymous" API context is logged in](playwright-request-context-inherits-storage-state.md) - the 401 test that asserted against a session
