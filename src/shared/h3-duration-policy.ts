export const H3_PRODUCT_MIN_DURATION_SEC = 5;
export const H3_PRODUCT_DEFAULT_MAX_DURATION_SEC = 15;
export const H3_PRODUCT_DURATION_STEP_SEC = 1;

export function h3ProductDurationMin(providerMinimumSec: number): number {
  return Math.max(H3_PRODUCT_MIN_DURATION_SEC, Math.ceil(providerMinimumSec));
}

export function isH3ProductDurationCompatible(durationSec: number, providerMinimumSec: number, providerMaximumSec: number): boolean {
  const minimumSec = h3ProductDurationMin(providerMinimumSec);
  return Number.isInteger(durationSec) && durationSec >= minimumSec && durationSec <= Math.floor(providerMaximumSec);
}
