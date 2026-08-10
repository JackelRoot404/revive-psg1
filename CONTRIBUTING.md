# Contributing

Revive PSG1 is an unfinished community handoff. Contributions are welcome, but
the repository does not currently have a funded maintainer or support SLA.

## Safety rules

- Keep `INSTALLER_MODE=scan_only` by default.
- Do not enable public flashing without the evidence gates in
  [`docs/community-handoff.md`](docs/community-handoff.md).
- Never commit firmware, APKs, device dumps, user reports, credentials, signing
  keys, signed private manifests, database exports, or proprietary device data.
- Do not broaden USB drivers or hardware profiles to generic Rockchip or Android
  devices.
- Tests and simulated fixtures never count as physical-device validation.

## Development workflow

1. Open an issue explaining the user impact and safety boundary.
2. Keep changes small and add tests for policy, USB, journal, and resume paths.
3. Run `npm run typecheck`, `npm test`, and `npm run build`.
4. Document any hardware observation as redacted evidence with the tester's
   explicit consent.
5. Submit a pull request. By contributing, you agree that your contribution is
   licensed under Apache-2.0.

Security-sensitive findings must follow [`SECURITY.md`](SECURITY.md), not a
public issue.
