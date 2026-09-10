# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud
identity and relay credentials belong to a separate trust boundary, described in
[T3 Connect](./t3-connect.md). A relay token is never an environment login.

## Authority survives transport changes

Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow
that grant but cannot widen it. Ordinary pairing does not grant access-management
or relay-management authority. Creating another pairing link requires both
`access:write` and every scope being delegated. The
[auth handlers](../../apps/server/src/auth/http.ts) enforce this at issuance;
client labels and device metadata have no authorization role.

The access read model contains pairing metadata, never recoverable pairing
secrets. Only the creation response returns the raw credential. Otherwise read
access to the connections list would become a way to acquire another client's
authority.

Browser cookies, bearer tokens, and DPoP tokens adapt the same scoped session
model. DPoP binds a token to a client's proof key; an invalid proof must fail
rather than fall back to bearer authentication. The OAuth token-exchange
vocabulary gives these grants a familiar meaning, but the environment does not
implement a general-purpose OAuth authorization server.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. Browser sessions can
authenticate the upgrade with their cookie. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts).

Desktop restarts forget the previous local bearer token, so its reusable
bootstrap grant replaces earlier sessions for the same subject and method.
Revocation and insertion share a [database
transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed
replacement must leave the old credential usable. Pairing and browser sessions
do not follow this replacement rule.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes.
`orchestration:read` permits reading files the server account can read, including
absolute paths outside a project. This lets clients display artifacts that an
agent writes in a temporary directory. Relative paths and writes still follow
the [workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.

## Subject

Scopes say what a session may do. Its `subject` says who it is, and a handful of
rules key on that instead. Two subjects are named in code:

| Subject         | Who                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------- |
| `cloud-connect` | A session the managed relay minted, rather than a person on this machine.                    |
| `firstmate`     | The First Mate daemon's own bearer, minted with `t3 auth session issue --subject firstmate`. |

`firstmate` is `AuthFleetSubject` in the contracts. A session carrying it is the
fleet's, so the daemon may create a read-only thread and then prompt that
thread, which the user it is read-only for may not.

Its scopes are `AuthFleetScopes`, `orchestration:read orchestration:operate`
and nothing else. The daemon reads snapshots and dispatches orchestration
commands; it runs no terminals, composes no review feedback, manages no pairing
links and touches no relay, so it gets neither the rest of the standard client
scopes nor any administrative one. `t3 auth session issue` pins that set to
this subject rather than trusting `--scopes`, and refuses a wider set under it
rather than quietly narrowing one. That matters more here than for an ordinary
bearer: this is the one subject the server lets create a thread the user cannot
prompt, so the blast radius of the token is worth keeping small. Mint one with:

```
t3 auth session issue --label "First Mate" --subject firstmate --ttl 1h --json
```

See [worker threads](./acp-worker-threads.md).
