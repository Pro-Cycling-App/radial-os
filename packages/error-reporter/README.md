# Error Reporter

This private Worker implements Cloudflare OS's vendor-neutral `ErrorReporter` RPC contract. The bundled implementation writes each bounded issue event as one structured `console.error()` object, which [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) indexes without an external SDK.

That console call is a demonstration of the collection path, not the intended end state. It gives every deployment a working, queryable destination before anyone picks a collector. Replace it once you know where exception events should live.

The Workshop binding supplies trusted `service`, `environment`, and optional `release` metadata. A report looks like:

```json
{
  "event": "error_report",
  "service": "cloudflare-os-workshop",
  "environment": "production",
  "release": "abc123",
  "schemaVersion": 1,
  "occurrenceId": "...",
  "occurredAt": "...",
  "failureSite": "overseer.run-agent",
  "severity": "error",
  "handled": false,
  "exception": { "type": "Error", "message": "...", "stack": "..." }
}
```

This is an issue destination, not a catch-all. Uncaught Worker failures remain in the producing Worker's logs; only explicit upstream `reportIssue()` calls arrive here.

## Replace the destination

Keep the `ErrorReporter` entrypoint and the `report(event)` signature. Everything inside `report()` is yours, and producers need no change because the bindings and the bounded event contract stay the same.

Things the replacement usually does:

- POST the event to an exception collector such as Sentry, grouped by `failureSite` and `exception.type`.
- Attach `release` so the destination can symbolicate the stack against the matching source maps.
- Route by severity, paging on unhandled `error` events and filing the rest.
- Drop or sample noisy `failureSite` values before they reach a per-event billing plan.

Wrap the transport in `try`/`catch` so a destination outage never reaches the caller. Reporting stays best-effort and private: never add secrets, prompts, tokens, headers, or request/response bodies to exceptions or attributes.

See [Observability and error reporting](../../docs/observability.md) for deployment controls, triage, browser reporting, source maps, and external export options.

## Check

```sh
pnpm run test:run
pnpm run types:check
pnpm exec wrangler deploy --dry-run
```
