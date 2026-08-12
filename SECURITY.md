# Security Policy

This repository is a GitHub Action. **It runs inside other people's CI**, with their
`GITHUB_TOKEN` and their DecimalAI API key, on pull requests that anyone may have opened. That
shapes what counts as a security problem here, so this policy is more specific than a library's.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Two ways to reach us, either is fine:

- **GitHub private vulnerability reporting** — **Security → Report a vulnerability** on this
  repository. That opens a private advisory only maintainers can see.
- **Email** — [hello@decimal.ai](mailto:hello@decimal.ai). A PGP key is available on request if you
  would rather not send details in cleartext.

Include what you have: what you found, how to reproduce it, which tag or ref of the Action you ran,
and what an attacker could actually do with it. A minimal workflow file that demonstrates it is the
most useful thing you can send.

## Scope

The Action receives two secrets — `api-key` (a DecimalAI key, from the caller's GitHub Secrets) and
`github-token` (by default the automatic per-job `github.token`, which the caller has granted
`pull-requests: write`). Both are registered with `core.setSecret` so the runner masks them in logs.
Anything that gets a secret out of that boundary, or uses it for more than its stated job, is in
scope:

- **Secret disclosure** — either token appearing unmasked in Action logs, in the PR comment, in an
  artifact, in an error message, or sent to any host other than the DecimalAI API and GitHub.
- **Token overreach** — the Action using the caller's `GITHUB_TOKEN` for anything beyond posting and
  updating its own PR impact comment.
- **Comment injection** — content that reaches the rendered PR comment from a place a pull request
  author controls (agent name, manifest contents, API response fields) and that escapes its cell to
  forge report text, inject a link, or otherwise mislead a reviewer about the verdict. The comment is
  a merge gate; making it lie is a security problem, not a formatting bug.
- **Verdict integrity** — any way to make the Action report `no_change` or a green verdict, or to
  make it exit zero under `fail-on: high`, while the manifest change is in fact high impact.
- **Untrusted input handling** in `src/` — inputs, API responses, and manifest IDs read from
  `$GITHUB_OUTPUT` or `./decimal_manifest_id.txt` all originate outside the Action.
- **The published artifact.** The Action runs the bundled `dist/index.js`, not `src/`. A `dist/`
  build that does not correspond to this source tree, or a bundled dependency that introduces a
  problem the source does not have, is in scope — and is exactly the kind of thing worth reporting
  privately.
- Anything in `action.yml` whose defaults cause a caller following the README to hand out more
  permission than they meant to.

**Out of scope**

- The caller's own workflow configuration. Running this Action from a `pull_request_target` trigger
  that also checks out untrusted PR code, or granting it `contents: write`, is a problem in that
  workflow. If our README leads people there, that *is* our bug — tell us and we will fix the
  documentation.
- Vulnerabilities in `actions/checkout`, `actions/setup-python`, the GitHub Actions runner itself, or
  the `@actions/*` toolkit. Report those to their maintainers; tell us too if our use of them is what
  makes the issue reachable.
- The DecimalAI hosted API (`api.decimal.ai`) that the Action calls. Report those the same way, to
  the same address; they are just fixed elsewhere.
- The fact that the Action sends manifest metadata to the DecimalAI API. That is what it is for, and
  it is documented. Sending something the documentation does not describe is in scope.
- Scanner output with no demonstrated impact.

## What happens next

We are a small team, so rather than publish a response time we cannot hold to, here is what we
actually do:

- We acknowledge a report once we have read it, and we say plainly if triage is going to take a
  while.
- We tell you whether we consider it in scope and what we intend to do.
- We follow coordinated disclosure. We agree a timeline with you rather than impose one, and we will
  not ask you to stay quiet indefinitely. Because callers pin a major tag (`@v1`), a fix means both a
  patch release and a moved tag, and we will tell you when both have happened.
- We are happy to credit you in the advisory and the release notes. Tell us how you would like to be
  named, or say that you would rather not be.

There is no paid bug bounty. That is a resourcing decision, not a judgment about the value of your
work.

## Safe harbour

If you make a good-faith effort to follow this policy, we will not pursue or support legal action
against you for your research. Good faith means avoiding privacy violations and service degradation,
only testing against repositories and accounts you own or have permission to test — please do not
exercise this Action against someone else's CI — and giving us a reasonable opportunity to fix the
issue before you disclose it publicly.

If you are not sure whether what you found is a security issue, email
[hello@decimal.ai](mailto:hello@decimal.ai) and ask. That is always the right call.
