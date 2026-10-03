# Releasing

No npm publication. Keep `private: true`.

1. Update version/changelog/docs on a feature branch. Use Node 24 and the lockfile; run check, format check, pack and isolated packaged smoke. Review the package contents and diff for private data.
2. Open a non-draft PR. Require green strict `verify`, resolve conversations and squash merge under protected main. Do not bypass administrator enforcement.
3. Fetch main, verify the merged SHA and rerun clean checks/pack/smoke. Tag that exact commit `v0.1.0` and push the tag.
4. Generate the tarball with `npm pack --json`; compute `sha256sum pi-generation-recovery-0.1.0.tgz > SHA256SUMS`.
5. Create the GitHub release with the tarball and checksum. Download assets and verify the checksum. Record limitations honestly, especially live versus deterministic opaque-state coverage.
6. In a temporary working directory with a temporary `PI_CODING_AGENT_DIR`, verify `pi install git:github.com/jacek4yang/pi-generation-recovery@v0.1.0`; never modify the production agent configuration. Verify installed source loading.

Repository governance: PR required, 0 external approvals for a single maintainer, strict required `verify`, conversation resolution, linear history, admin enforcement, no force push, squash merge only, auto-merge allowed, delete merged branches. Actions are pinned to immutable SHAs. Companions are optional pinned development fixtures, not runtime dependencies.
