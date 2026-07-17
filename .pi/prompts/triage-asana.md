---
description: Triage assigned Asana tickets and assess implementation readiness
argument-hint: "[project]"
---
Triage my pending Asana work for `${1:-the current work project}`.

Do not implement or modify project files during this triage.

1. Identify the correct Asana workspace/project and my identity. If Asana access is unavailable, stop and explain exactly what integration or credential is missing.
2. Find tickets assigned to me in relevant active sections, including in progress and next sprint/planned work.
3. For every candidate, inspect the full description, comments, subtasks, dependencies, links, attachments, and images. Do not classify a ticket from its title alone.
4. Correlate ticket details with existing repository docs, specs, branches, worktrees, and local changes when useful. Do not assume stale local work is authoritative.
5. Classify each ticket as:
   - `ready`: enough context and clear acceptance criteria;
   - `clarify`: likely actionable but specific information is missing;
   - `blocked`: dependency or external decision prevents work;
   - `investigate`: requires a bounded technical spike before estimating implementation.
6. For every non-ready ticket, state the precise missing questions or blocker. Avoid generic phrases such as “needs more context.”
7. For every ready ticket, summarize scope, acceptance criteria, affected systems, risks, and likely verification.
8. Recommend the best next ticket based on readiness, priority, dependencies, and ability to isolate it safely.

Return a compact table first, followed by detailed notes and a recommended next action. Wait for my selection before starting design or implementation.
