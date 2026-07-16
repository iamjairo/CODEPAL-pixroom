# Common MCP use cases: research and comparisons

_Research snapshot: 2026-07-16._

There is no public ecosystem-wide census of MCP workflows. We therefore did not
pretend that one directory or a search result could prove a universal ranking. The
comparison set uses three observable signals:

1. current official MCP reference servers and example integrations;
2. official vendor MCP servers and the jobs their maintainers document;
3. public adoption signals such as package downloads, repository stars, releases,
   dependents, and supported clients.

The clearest recurring categories were local files, source control and GitHub,
browser automation, web research, SQL and data stores, persistent knowledge,
project documentation and issue tracking, team messaging, observability/logs, and
small utilities such as time conversion.

## What we executed

| Common job | Published MCP used | Comparison |
|---|---|---|
| Read files and customer exports | Filesystem `2026.7.10` | [Lookup](./customer-record-lookup.md), [count](./active-account-count.md), [log triage](./incident-log-triage.md) |
| Work with local source history | Git `2026.7.10` | [Large commit triage](./large-commit-triage.md) |
| Recall stored knowledge | Memory `2026.7.4` | [Full graph](./knowledge-graph-lookup.md), [native lookup control](./native-filter-passthrough.md) |
| Research a web page | Fetch `2026.7.10` | [Web research](./web-research.md) |
| Query structured data | DBHub `0.23.0` | [Large SQL report](./database-query.md) |
| Inspect and automate a browser | Playwright MCP `0.0.78` | [Large accessibility snapshot](./browser-snapshot.md) |
| Convert timezones | Time `2026.7.10` | [Bounded utility control](./timezone-conversion.md) |

All ten cases use pinned published servers, deterministic synthetic fixtures, and
exact graders. Eight oversized responses improved by 98.6% to 99.5%. Two controls
were byte-identical because their upstream MCP operations were already bounded.

## Why these categories

- The [official MCP examples](https://modelcontextprotocol.io/examples) currently
  feature Fetch, Filesystem, Git, Memory, and Time as reference servers.
- The [official reference-server repository](https://github.com/modelcontextprotocol/servers)
  showed 88,500 stars and 11,200 forks when checked, and its historical examples also
  cover GitHub, Google Drive, PostgreSQL, browser automation, Redis, Sentry, Slack,
  SQLite, and search.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) showed 35,200 stars;
  its npm package reported 6,451,720 weekly downloads and 99 dependents. It documents
  browser exploration, self-healing tests, and long-running automation.
- [GitHub's official MCP server](https://github.com/github/github-mcp-server) showed
  31,500 stars and documents repository work, issues and pull requests, CI/CD,
  security analysis, and team collaboration.
- [DBHub](https://github.com/bytebase/dbhub) showed 3,200 stars; its npm package
  reported 18,206 weekly downloads. It supports SQL execution and schema exploration
  across PostgreSQL, MySQL, MariaDB, SQL Server, and SQLite.
- [Notion MCP](https://developers.notion.com/docs/mcp) documents workspace search,
  documentation, tasks, reports, and campaign planning.
- [Atlassian's official MCP server](https://github.com/atlassian/atlassian-mcp-server)
  documents Jira search and updates, Confluence content, service management,
  Bitbucket, and Compass workflows.
- The maintained [Slack MCP server](https://github.com/zencoderai/slack-mcp-server)
  exposes channel history, threads, users, reactions, and messaging.

These counts are dated adoption signals, not a cross-category popularity score.

## Researched but not executed

GitHub, Jira/Confluence, Notion, and Slack are common enough to belong in the research
set, but their representative servers require OAuth, API tokens, workspace access, or
scoped application setup. We did not reuse personal credentials, hit production data,
or replace those services with a fake server and call that interoperability evidence.

The next valid step is to create disposable sandbox organizations, seed synthetic
issues/pages/messages, use least-privilege read-only scopes, and run the same paired
exact-answer and client-boundary checks. Until then, those rows remain planned rather
than published as Pinpoint wins.

## Evidence boundary

The [canonical receipt](../benchmarks/results/mcp-common-workflows.first-party-macos-arm64-20260716.json)
measures data-bearing MCP response bytes and exact deterministic answers. It does not
measure provider tokens, model quality, cost, latency, production demand, or every
possible configuration of these servers.