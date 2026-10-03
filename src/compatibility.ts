/** Exact public lifecycle baseline, expanded only alongside SDK regression evidence. */
export const SUPPORTED_PI = "1.0.1";
export function assertSupportedPi(version: string): void {
  if (version !== SUPPORTED_PI)
    throw new Error(
      `pi-generation-recovery supports Pi ${SUPPORTED_PI}; found ${version}. Recovery is disabled: validate the retry/omission lifecycle before upgrading.`,
    );
}
