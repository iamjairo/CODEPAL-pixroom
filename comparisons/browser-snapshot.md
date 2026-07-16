# Inspect a large browser page without loading the whole accessibility tree

> **Same exact page target. 98.6% less client-visible response data.**

## The everyday job

You ask a browser agent to inspect a large page and find `browser-target-0427` in
its accessibility snapshot.

## Without Pinpoint

Playwright MCP returns the full accessibility snapshot inline. The client receives all
2,000 page markers before locating the one target.

## With Pinpoint

Pinpoint keeps the inline accessibility tree local and returns an artifact handle. A
literal bounded `grep` retrieves the exact target row.

## Result

| Measurement | Without Pinpoint | With Pinpoint |
|---|---:|---:|
| Correct answer | **Yes** | **Yes** |
| Client-visible response | **97,147 bytes** | **1,378 bytes** |
| Unrelated fixture values visible | **1,999** | **0** |
| Reduction |  | **98.6% less** |

Both arms found `browser-target-0427`. Pinpoint avoided sending the other 1,999
accessibility-tree markers through the data-bearing client transcript.

Benchmark case: `playwright-browser-snapshot`

[Canonical receipt](../benchmarks/results/mcp-common-workflows.first-party-macos-arm64-20260716.json) · [Research method](./README.md) · [Run the comparison](../benchmarks/REPRODUCING.md#common-mcp-workflow-comparison)

_This is a paired synthetic protocol test using the default inline `browser_snapshot` behavior in `@playwright/mcp@0.0.78`. Navigation was symmetric fixture setup. Bytes are MCP response bytes, not model tokens or cost._