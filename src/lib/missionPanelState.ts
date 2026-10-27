/** How the customer left the mission plan panel (desktop): expanded or collapsed to a rail, pinned or not. Kept in the browser only, as a convenience; any failure means the default. */
export const PANEL_STATE_KEY = "diger.missionPanel.v1";
export interface PanelState { expanded: boolean; pinned: boolean }
export const defaultPanelState = (): PanelState => ({ expanded: true, pinned: false });

export function parsePanelState(raw: string | null | undefined): PanelState {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    return { expanded: parsed?.expanded !== false, pinned: parsed?.pinned === true };
  } catch {
    return defaultPanelState();
  }
}

/** The id of one planning turn, made by the page: letters and digits only (the server accepts 8 to 64 of A-Z a-z 0-9 _ -). */
export function newPlannerRequestId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `p${random}`.slice(0, 40);
}
