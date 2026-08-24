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
- [The Claude auth token is an OAuth token, never an API key](auth-token-handling.md) - an ANTHROPIC_API_KEY overrides the subscription
- [Git tokens reach the container through a credential helper](git-token-via-credential-helper.md) - keeps them out of .git/config and logs
- [The container user is UID 1001, not 1000](container-user-uid-1001.md) - the node image already took 1000
- [tmux attach through docker exec needs TERM in the image](tmux-attach-needs-term.md) - fails with "terminal does not support clear"
- [A failed clone must not kill the container](failed-clone-must-not-abort.md) - a dead container is unreachable for diagnosis
- [Project environments are prebuilt images, not devcontainer features](project-images-not-devcontainer-features.md) - devcontainer features have no layer caching
- [The dev host is Windows, the target is Linux](windows-dev-host-linux-target.md) - line endings and MSYS path rewriting bite
