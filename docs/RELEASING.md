# Releasing

No npm publication. Keep `private: true`.

1. Update version/changelog/docs and exact Pi compatibility evidence on a feature branch. Use Node 24 and the lockfile; run clean install, check, format check, pack and isolated packaged smoke. Review package contents/diff for private data.
2. Open a non-draft PR. Require green strict `verify`, resolve conversations and squash merge under protected main. The required job aggregates all exact SDK matrix jobs. Never bypass administrator enforcement.
3. Fetch main, verify merged SHA and rerun clean checks/pack/smoke. Tag that exact commit `v0.2.0` and push the tag.
4. Generate `pi-generation-recovery-0.2.0.tgz` with `npm pack --json`; compute `sha256sum pi-generation-recovery-0.2.0.tgz > SHA256SUMS`.
5. Publish GitHub release notes and attach tarball/checksum. Download assets and verify checksum. Distinguish deterministic tests from real opaque-state live evidence and document platform/retention limits.
6. In a temporary working/agent directory, verify `pi install git:github.com/jacek4yang/pi-generation-recovery@v0.2.0`. Verify installed public source loading and an actual SDK recovery. Never change production configuration.

Governance: PR required, 0 external approvals for a single maintainer, strict `verify`, conversation resolution, linear history, admin enforcement, no force push, squash only, auto-merge allowed, delete merged branches. Actions use immutable SHAs; companions are optional development fixtures.
