# Server identity

TaskDock IDs are local. Native MCP `taskId` values are server-owned. The join
key is the server the handle belongs to.

A display name is not that key. Two clients can label the same endpoint
differently, and one name can be reused after a URL change.

## What is stored

Each server profile has:

| Field | Role |
| ----- | ---- |
| `id` | Local alias you pass to `--server`. Stable only inside this database. |
| `name` | Display copy. Defaults to `id`. Not used for identity. |
| `transport` | How to reconnect: HTTP URL, or stdio command + args. |
| `authProfile` | `env:VAR` or empty. Never a secret. |
| `fingerprint` | SHA-256 of the canonical non-secret endpoint + auth reference. |

`fingerprint` is computed on write. Callers cannot supply one.

## Canonical form

HTTP:

- drop URL userinfo (username/password)
- lowercase scheme and host
- drop default ports (`:80`, `:443`)
- drop a trailing slash on a non-root path
- keep the query string (it can be part of the mount)
- drop the fragment

stdio:

- command string plus args, in order

Auth:

- the `env:VAR` reference, or empty

The local `id` and `name` are not hashed. Two aliases for the same endpoint
share a fingerprint and remain two rows. TaskDock does not auto-merge them.

## What this is for

- Detect that two profiles point at the same place.
- Survive client restarts: the same URL + auth reference hashes the same.
- Migration: re-adding a profile with a new `id` still produces the same
  fingerprint, so you can compare.

It is not a cryptographic server attestation. A process that takes over an
IP can keep the fingerprint. `server/discover` `name` / `version` is stored
when the server is reachable at register time, or on the first successful
`get` / `cancel` / `update`. Later calls warn on mismatch and still send the
native request.

## Secrets

Fingerprints and `transport_json` must not contain credentials. HTTP userinfo
is stripped before either is stored. Auth is `env:VAR` only. The env value is
read at call time.

See [PROTOCOL_NOTES.md](PROTOCOL_NOTES.md) for why URL-alone is still not a
universal server identity across gateways and stdio.
