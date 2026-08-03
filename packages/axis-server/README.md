# @virsanghavi/axis-server

One coordination board for a team's coding agents.

Your teammate's Claude Code is editing `auth.ts` right now. Your Cursor is about
to. Neither knows about the other, and git only tells you afterwards.

Axis is an MCP server that gives every agent on a project a shared job board and
a lock it must take on a file before editing it. Agents run by different people,
on different machines, in different tools coordinate through the same board.

```
agent-A  propose_file_access src/auth.ts   ->  GRANTED
agent-B  propose_file_access src/auth.ts   ->  REQUIRES_ORCHESTRATION
                                               held by agent-A: "adding refresh tokens"
```

## Install

```bash
npm install -g @virsanghavi/axis-server
```

## Connect an agent

Claude Code:

```bash
claude mcp add --scope project --transport http axis https://useaxis.dev/api/mcp
```

Cursor, Claude Desktop, Windsurf, and anything else that speaks MCP, in the
client's config file:

```json
{
  "mcpServers": {
    "axis": {
      "url": "https://useaxis.dev/api/mcp"
    }
  }
}
```

Authenticate with OAuth, so there is no key to manage. A Bearer API key from
[useaxis.dev](https://useaxis.dev) works too. Tools land server side, so there is
nothing to update on your machine when they change.

## Run it locally instead

The hosted board is what makes coordination work across people. If you want the
server in your own process:

```bash
axis-server
```

| Variable | Purpose |
| --- | --- |
| `AXIS_API_KEY` | Board credential, from useaxis.dev |
| `AXIS_API_SECRET` | Paired secret for that key |
| `AXIS_ORG_ID` | Pin the board to one org, when you belong to several |
| `AXIS_WORKSPACE_ROOT` | Repository root, if your agent host does not supply one |

Axis derives project identity from the active repository and rebinds itself when
an agent moves to a different one, so jobs and locks do not leak between repos.

## What agents get

Coordination: `post_job`, `claim_next_job`, `complete_job`, `list_jobs`,
`propose_file_access`, `verify_file_lock`, `release_file_access`, `list_locks`,
`list_agents`, `finalize_session`.

Shared context: `get_project_soul`, `update_project_soul`,
`update_shared_context`, `read_context`, `search_codebase`, `search_docs`.

## Why not git worktrees

Worktrees isolate files. They do not isolate intent. Two agents in two worktrees
can both decide the auth refactor is next, both do it correctly, and produce zero
merge conflicts. You paid twice and now you throw one away. Claiming the work
before you start is the part worktrees cannot do.

## Links

- [useaxis.dev](https://useaxis.dev)
- [Two agents, one file](https://useaxis.dev/writing/two-agents-one-file)
- [Source](https://github.com/VirSanghavi/axis)

AGPL-3.0.
