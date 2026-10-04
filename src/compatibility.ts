/** Tested floor; accept stable patches of the same public API minor line. */
export const SUPPORTED_PI = "~1.0.2";
export function assertSupportedPi(version: string): void {
  if (!/^1\.0\.(?:[2-9]|[1-9]\d+)$/.test(version))
    throw new Error(
      `pi-generation-recovery supports Pi ${SUPPORTED_PI}; found ${version}. Recovery is disabled: validate the retry/omission lifecycle before upgrading.`,
    );
}
