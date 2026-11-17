# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/to-rubot/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/to-rubot/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge that runs as one Node 22 process with no
dependencies beyond the standard library. One in-memory store backs four
surfaces:

- **git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (`ls-refs`,
  `fetch` with shallow/deepen) and the v0 fallback, plus v0 `receive-pack`
  with report-status. Packs are read and written natively (SHA-1 objects,
  OFS/REF delta resolution); there is no git binary involved.
- **REST v3** under `/api/v3` — repositories, contents (backed by real git
  commits), branches, git refs, commits, labels, issues, comments and pull
  requests with a real three-way squash merge.
- **GraphQL** at `/api/graphql` — viewer/repository/issue/pullRequest
  queries, connections with cursor pagination, introspection, and the
  create/close/merge mutations, executed by a small hand-written parser.
- **MCP** at `/mcp` — JSON-RPC over Streamable HTTP with `server/discover`,
  the legacy `initialize` handshake, and tools that act on the same store
  as the REST surface.

State is deliberately deterministic: timestamps and ids come from a logical
clock and counters, never from the wall clock, so a replayed trial produces
the same answers.

## Run it

```sh
# The harness provides MAKEFUN_ENV_URL (registration/done endpoint) and
# MAKEFUN_SHOP_TOKEN (the bearer token every surface authenticates against).
node main.ts
```

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ct23hw4p&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
