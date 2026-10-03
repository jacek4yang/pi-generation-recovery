# Security policy

The latest 0.2.x release is supported for security fixes. Report vulnerabilities privately through [GitHub security advisories](https://github.com/jacek4yang/pi-generation-recovery/security/advisories/new). Do not include tokens, cookies, raw provider events, encrypted reasoning blobs, production sessions or journals. Provide a synthetic reproducer and sanitized runtime/version metadata.

Journals are private local session data, not encrypted by this extension. Keep directory/backups private; do not share them in issues. No telemetry or cloud recovery service exists. A compromised local account can read or alter session data; hashes are integrity checks, not authentication against that account.

The extension never executes partial tool calls, owns credentials or retries independently. If a safety issue is suspected, set `PI_GENERATION_RECOVERY_MODE=off`, restart Pi and preserve only sanitized diagnostic information.
