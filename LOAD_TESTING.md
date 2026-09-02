# Production Load and Failure Testing

Run the normal development load harness:

```bash
npm run test:load
```

Run the full capacity harness:

```bash
npm run test:load:full
```

The full preset exercises:

- 100,000 message records in the service search/status layer
- 10,000 persistent scheduled-email task files
- 1,000 concurrent mailbox-status clients
- scheduler startup/index scan
- interrupted `sending` task recovery to a safe failed/unknown-delivery state

The harness uses a mock outbound transport and never sends real email. The measurements are environment-specific diagnostics, not production latency guarantees.
