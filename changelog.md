# Changelog

## 2026-10-04

- Wait for each Codex shell page to finish loading and mount its document before running theme operations, to guard against startup timing failures.
- Report the CDP exception description and stack instead of only `Uncaught`.
- Changed `codex-theme.mjs`. Verified syntax, diff formatting, readiness polling and timeout, and the installed `/Applications/Codex Theme.app` launcher. Both current shell windows report `applied: true` and `observerInstalled: true`.
- The original exception detail was not retained; its exact cause and a fresh cold launch remain unverified. The running app was kept open.
