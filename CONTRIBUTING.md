# Contributing to regression-check

Thanks for your interest. This is a GitHub Action, which shapes everything below: the
Action is loaded from committed build output, so `dist/` is a deliverable, not an artefact.

## Before you open a PR

```bash
npm install
npm run lint       # tsc --noEmit
npm test
npm run build      # regenerates dist/index.js — COMMIT THE RESULT
```

**`dist/` must be committed and must match `src/`.** A PR that changes `src/` without a
rebuilt `dist/` ships the old code to every consumer, and nothing at runtime will tell you.
This is why `dist/` is deliberately not in `.gitignore`.

## What a PR is expected to contain

- A test covering the new behaviour.
- A rebuilt, committed `dist/`.
- An `action.yml` update if you added or renamed an input — inputs are the public API of an
  Action, and renaming one breaks every workflow that uses it.

## Reporting bugs

Open an issue with the workflow snippet that reproduces it and a link to the failing run if
it is public. For anything security-related see [SECURITY.md](SECURITY.md) — please do not
open a public issue.
