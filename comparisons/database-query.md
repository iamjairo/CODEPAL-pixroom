# Find one database row without returning the whole report

> **Same exact database value. 98.7% less client-visible response data.**

## The everyday job

You run a 1,000-row SQL report and need the status for row 733. This is the common
database-agent pattern: execute a query, inspect the result, and pull out one useful
record.

## Without Pinpoint

DBHub returns the complete structured report through MCP. The client receives all
1,000 rows before selecting `database-target-0733`.

## With Pinpoint

Pinpoint discovers DBHub's nested `data.rows` collection, keeps it local, and returns
only the `status` field for `id: 733`.

## Result

| Measurement | Without Pinpoint | With Pinpoint |
|---|---:|---:|
| Correct answer | **Yes** | **Yes** |
| Client-visible response | **117,099 bytes** | **1,468 bytes** |
| Unrelated fixture values visible | **999** | **0** |
| Reduction |  | **98.7% less** |

Both arms returned `database-target-0733`. Pinpoint selected it from the exact DBHub
result without sending the other 999 synthetic row markers through the data-bearing
client transcript.

Benchmark case: `database-large-query-result`

[Canonical receipt](../benchmarks/results/mcp-common-workflows.first-party-macos-arm64-20260716.json) · [Research method](./README.md) · [Run the comparison](../benchmarks/REPRODUCING.md#common-mcp-workflow-comparison)

_This is a paired synthetic protocol test using `@bytebase/dbhub@0.23.0` in its local demo mode. Bytes are MCP response bytes, not model tokens or cost._