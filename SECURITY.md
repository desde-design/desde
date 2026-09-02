# Security Policy

Desde is a small, new project. As of this writing it is pre-1.0 and maintained
by one person. This policy says that plainly so a report goes in with the
right expectations: it will be read personally, but there is no dedicated
security team and no guaranteed response time.

## Reporting a vulnerability

Email **security@desde.design**. Do not open a public GitHub issue for a
security problem.

Include what you can:

- What you found, and why it is a problem.
- Steps to reproduce it.
- The version or commit you tested against.
- Whether you plan to disclose it publicly, and on what timeline.

## What to expect

There is no guaranteed response time, and no promised turnaround. A best
effort is to acknowledge a report within a few days. A fix can take longer,
depending on severity and what else is already in progress.

There is no bug bounty. This is not a funded project, and there is no budget
for one.

Coordinated disclosure is preferred: report privately, give time for a fix,
then disclose. A researcher who does this will get credit in the fix notes,
if they want it.

## Scope

Desde has two surfaces. The **Editor** is a local CLI that runs on someone's
own machine. The **Viewer** is a self-hostable app that an operator runs on
their own server. Most Viewer deployments are the operator's own
responsibility, in the same way any self-hosted software is. What is in
scope here is Desde's own code.

**In scope.** Vulnerabilities in Desde's own code, particularly around these
boundaries:

- **The bridge's postMessage origin discipline** (`src/bridge/`). Desde
  loads a prototype inside an iframe. A script called the bridge runs inside
  that iframe and talks to the surrounding app (called the shell) over
  `postMessage`. The origin discipline is what stops an unrelated page from
  reading a prototype's DOM, or sending it commands, by framing it and
  posting messages of its own. The discipline fails closed: if the shell
  origin cannot be resolved, the bridge refuses to post rather than falling
  back to a wildcard target. That followed a real incident, where the old
  fail-open fallback let a cross-origin page read a prototype's design
  tokens and inspector data.
- **Viewer access control** (`viewer/server/auth/authorize.ts`). This
  decides who can read or manage a project. A private project is meant to
  404 the same way for anyone who cannot see it, never a 403, because a 403
  would itself confirm the project exists.
- **The Editor CLI's edit path guards**
  (`editor-cli/src/server/edit-handler.ts` and
  `editor-cli/src/server/resolve-editable-path.ts`). These stop a write
  request from landing outside the repository the Editor was pointed at,
  including through a symlink.
- **Machine token handling** (`viewer/server/auth/machine-token.ts`).
  Machine tokens (`dsv_...`) are meant to be stored as a hash only. The raw
  token should never be logged or persisted anywhere after it is shown to
  the user once, at mint time.

**Out of scope**, or the operator's own responsibility rather than Desde's:

- How an operator deploys and runs their own Viewer instance: patching
  their server, their network setup, their choice of who gets an account.
  A report about a specific deployment, rather than a defect in Desde's
  code, should go to that operator, not here.
- A vulnerability in a third-party dependency, with no additional exploit
  path through Desde's own code. Report it upstream. If a dependency issue
  is genuinely exploitable through Desde beyond what a version bump already
  fixes, that part is in scope.
- Denial of service through raw traffic volume against a self-hosted
  instance. That is a hosting and rate-limiting concern for the operator.
- Anything that needs physical access to someone's machine.
- Social engineering.

## A note on AGPL and self-hosting

Desde is licensed AGPL-3.0-or-later. Anyone can run their own copy,
including a modified one. Desde's maintainer cannot audit or patch someone
else's fork or deployment. This policy covers the code in this repository,
not what a third party does with it.
