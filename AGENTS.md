# AGENTS.md

## Project Goal

This repository is a Infrastructure / tooling foundation. Keep changes focused on the user-facing project goal, not on internal process decoration.

## Before Changing Files

- Read `README.md` and `PROJECT_MEMORY.md` first.
- Inspect the smallest relevant code or content path before proposing broad changes.
- Preserve existing architecture, routes, and user workflows unless the task explicitly changes them.

## Verification

- Prefer the narrowest command that proves the changed behavior.
- Run the CI/security commands when the change affects runtime, packaging, release, dependencies, or security.
- Verify generated files directly when users will rely on generated output.

## Safety

- Do not expose secrets, tokens, local paths, prompts, or execution logs in user-facing output.
- Do not delete or rewrite unrelated project files.
- Treat high and critical security findings as action-changing risks.
