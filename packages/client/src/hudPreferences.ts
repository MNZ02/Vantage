export const DEBUG_HUD_STORAGE_KEY = "vg.debugHud.visible";
export const DEBUG_HUD_EVENT = "vg:debug-hud-visibility";

interface ReadableStorage {
  getItem(key: string): string | null;
}

interface WritableStorage {
  setItem(key: string, value: string): void;
}

export function loadDebugHudVisible(storage?: ReadableStorage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DEBUG_HUD_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveDebugHudVisible(storage: WritableStorage | null | undefined, visible: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(DEBUG_HUD_STORAGE_KEY, String(visible));
  } catch {
    // Storage can be unavailable in privacy modes; the in-memory toggle still works.
  }
}

export interface DebugHudVisibilityDetail {
  visible: boolean;
}

export function dispatchDebugHudVisibility(visible: boolean): void {
  window.dispatchEvent(new CustomEvent<DebugHudVisibilityDetail>(DEBUG_HUD_EVENT, { detail: { visible } }));
}
