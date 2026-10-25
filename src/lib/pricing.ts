import { DEFAULT_CREDIT_VALUE_EGP } from "./creditValue";
import { TOPUP_PRESET_POINTS } from "./topupConfig";
import { pointsToEgp } from "./topupAmount";

/** The top-up presets in EGP at the default credit value; the presets themselves are in points (topupConfig). */
export const TOPUP_PRESETS_EGP = TOPUP_PRESET_POINTS.map((points) => pointsToEgp(points, DEFAULT_CREDIT_VALUE_EGP));
