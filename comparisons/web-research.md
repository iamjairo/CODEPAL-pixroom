# Find one fact without loading the whole web page

> **Same exact source line. 98.7% less client-visible response data.**

## The everyday job

You ask an assistant to find one named fact on a long research page. The page has
2,000 lines, but only the line tagged `WEB-RESEARCH-0427` answers the question.

## Without Pinpoint

The official Fetch MCP returns the whole page through the MCP client response. The
answer is in there, along with 1,999 unrelated fixture markers.

## With Pinpoint

Pinpoint keeps the fetched page local and returns an artifact handle. A literal
bounded `grep` retrieves the exact source line containing the requested tag.

## Result

| Measurement | Without Pinpoint | With Pinpoint |
|---|---:|---:|
| Correct answer | **Yes** | **Yes** |
| Client-visible response | **108,253 bytes** | **1,377 bytes** |
| Unrelated fixture values visible | **1,999** | **0** |
| Reduction |  | **98.7% less** |

Both arms returned `WEB-RESEARCH-0427: Pinpoint keeps the full research page local.`
The rest of the page stayed out of the Pinpoint-side data-bearing transcript.

Benchmark case: `fetch-web-research`

[Canonical receipt](../benchmarks/results/mcp-common-workflows.first-party-macos-arm64-20260716.json) · [Research method](./README.md) · [Run the comparison](../benchmarks/REPRODUCING.md#common-mcp-workflow-comparison)

_This is a paired synthetic protocol test using `mcp-server-fetch==2026.7.10`. Bytes are MCP response bytes, not model tokens or cost._