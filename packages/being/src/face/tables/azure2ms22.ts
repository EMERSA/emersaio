import { clampViseme, MS22_COUNT } from './ms22.ts';

/**
 * Azure Speech viseme ids are the canonical set, so this is the identity. It exists so every timeline format
 * goes through a named table and a future voice with a different id space is a one-file change.
 */
export const azure2ms22: readonly number[] = Array.from({ length: MS22_COUNT }, (_, id) => id);

export const azureToMs22 = (azureViseme: number): number => azure2ms22[clampViseme(azureViseme)] ?? 0;
