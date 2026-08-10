# Security policy

## Project status

This repository is an unfinished community handoff with no guaranteed response
time. The public configuration is scan-only and no release artifact is approved
for flashing.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting feature for findings that could
expose secrets, authorize destructive operations, bypass device/release binding,
or damage a handheld. Do not include private keys, full device identifiers,
firmware dumps, database contents, or personal data in an issue.

If private reporting is unavailable, publish only a minimal issue asking a
maintainer to enable it. Do not disclose exploit details until a community
maintainer has acknowledged the report and coordinated a fix.

## Supported versions

There is no supported production release. The `main` branch is research and
prototype software. Running the public installer or distributing artifacts
without completing the gates in `docs/community-handoff.md` is unsupported.
