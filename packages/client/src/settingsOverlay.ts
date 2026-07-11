// M5: minimal settings overlay — master/sfx/announcer volume sliders + a
// mute-when-tab-hidden checkbox, toggled by a gear icon (top-right) or the
// N key. Persists via audio/settings.ts's loadVolumeSettings/saveVolumeSettings.
import type { VolumeSettings } from "./audio/settings.js";
import {
  DEBUG_HUD_EVENT,
  dispatchDebugHudVisibility,
  loadDebugHudVisible,
  saveDebugHudVisible,
  type DebugHudVisibilityDetail,
} from "./hudPreferences.js";

export interface SettingsOverlay {
  toggle(): void;
  setOpen(open: boolean): void;
}

export function createSettingsOverlay(
  initial: VolumeSettings,
  onChange: (settings: VolumeSettings) => void,
  onOpenChange?: (open: boolean) => void,
  canOpen: () => boolean = () => true,
): SettingsOverlay {
  const current: VolumeSettings = { ...initial };

  const gearButton = document.createElement("button");
  gearButton.className = "vg-settings-button";
  gearButton.type = "button";
  gearButton.textContent = "⚙"; // gear glyph
  gearButton.title = "Settings (N)";
  gearButton.setAttribute("aria-label", "Open settings");
  gearButton.setAttribute("aria-haspopup", "dialog");
  gearButton.setAttribute("aria-expanded", "false");
  gearButton.style.position = "fixed";
  gearButton.style.zIndex = "21";
  gearButton.style.font = "16px monospace";
  gearButton.style.background = "rgba(0,0,0,0.5)";
  gearButton.style.color = "#fff";
  gearButton.style.border = "1px solid rgba(255,255,255,0.4)";
  gearButton.style.borderRadius = "4px";
  gearButton.style.cursor = "pointer";
  gearButton.style.padding = "2px 8px";
  document.body.appendChild(gearButton);

  const overlay = document.createElement("div");
  overlay.className = "vg-hud vg-modal-backdrop";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "22";
  overlay.style.display = "none";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(0,0,0,0.55)";
  overlay.style.font = "14px monospace";
  overlay.style.color = "#fff";
  overlay.setAttribute("aria-hidden", "true");

  const panel = document.createElement("div");
  panel.className = "vg-panel vg-settings-panel";
  panel.id = "vg-settings-dialog";
  gearButton.setAttribute("aria-controls", panel.id);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "vg-settings-title");
  panel.style.background = "#1c1f24";
  panel.style.border = "1px solid #444";
  panel.style.borderRadius = "6px";
  panel.style.padding = "16px 20px";
  panel.style.position = "relative";
  overlay.appendChild(panel);

  const title = document.createElement("div");
  title.className = "vg-panel__title";
  title.id = "vg-settings-title";
  title.textContent = "SETTINGS";
  title.style.marginBottom = "10px";
  title.style.opacity = "0.8";
  title.style.paddingRight = "36px";
  panel.appendChild(title);

  const closeButton = document.createElement("button");
  closeButton.className = "vg-settings-panel__close";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Close settings";
  closeButton.setAttribute("aria-label", "Close settings");
  closeButton.style.position = "absolute";
  closeButton.style.top = "10px";
  closeButton.style.right = "12px";
  closeButton.style.width = "30px";
  closeButton.style.height = "30px";
  closeButton.style.padding = "0";
  closeButton.style.border = "1px solid rgba(255,255,255,0.35)";
  closeButton.style.borderRadius = "2px";
  closeButton.style.background = "rgba(0,0,0,0.28)";
  closeButton.style.color = "#fff";
  closeButton.style.font = "22px/26px monospace";
  closeButton.style.cursor = "pointer";
  panel.appendChild(closeButton);

  function addSlider(label: string, key: "master" | "sfx" | "announcer"): void {
    const row = document.createElement("div");
    row.style.marginBottom = "10px";
    const rowLabel = document.createElement("label");
    rowLabel.textContent = `${label}: ${Math.round(current[key] * 100)}%`;
    rowLabel.style.display = "block";
    row.appendChild(rowLabel);
    const slider = document.createElement("input");
    slider.id = `vg-settings-${key}-volume`;
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(current[key] * 100));
    slider.setAttribute("aria-valuetext", `${slider.value} percent`);
    rowLabel.htmlFor = slider.id;
    slider.style.width = "100%";
    slider.addEventListener("input", () => {
      const v = Math.max(0, Math.min(1, Number(slider.value) / 100));
      current[key] = v;
      rowLabel.textContent = `${label}: ${Math.round(v * 100)}%`;
      slider.setAttribute("aria-valuetext", `${Math.round(v * 100)} percent`);
      onChange({ ...current });
    });
    row.appendChild(slider);
    panel.appendChild(row);
  }

  addSlider("Master", "master");
  addSlider("SFX", "sfx");
  addSlider("Announcer", "announcer");

  const muteRow = document.createElement("label");
  muteRow.style.display = "flex";
  muteRow.style.alignItems = "center";
  muteRow.style.gap = "6px";
  muteRow.style.marginTop = "6px";
  const muteCheckbox = document.createElement("input");
  muteCheckbox.type = "checkbox";
  muteCheckbox.checked = current.muteWhenTabHidden;
  muteCheckbox.addEventListener("change", () => {
    current.muteWhenTabHidden = muteCheckbox.checked;
    onChange({ ...current });
  });
  muteRow.append(muteCheckbox, document.createTextNode("Mute when tab is hidden"));
  panel.appendChild(muteRow);

  const interfaceTitle = document.createElement("div");
  interfaceTitle.className = "vg-settings-panel__section";
  interfaceTitle.textContent = "INTERFACE";
  panel.appendChild(interfaceTitle);

  const debugRow = document.createElement("label");
  debugRow.style.display = "flex";
  debugRow.style.alignItems = "center";
  debugRow.style.gap = "6px";
  const debugCheckbox = document.createElement("input");
  debugCheckbox.type = "checkbox";
  debugCheckbox.checked = loadDebugHudVisible(window.localStorage);
  debugCheckbox.addEventListener("change", () => {
    saveDebugHudVisible(window.localStorage, debugCheckbox.checked);
    dispatchDebugHudVisibility(debugCheckbox.checked);
  });
  window.addEventListener(DEBUG_HUD_EVENT, ((event: CustomEvent<DebugHudVisibilityDetail>) => {
    debugCheckbox.checked = event.detail.visible;
  }) as EventListener);
  debugRow.append(debugCheckbox, document.createTextNode("Performance telemetry (F3)"));
  panel.appendChild(debugRow);

  const closeHint = document.createElement("div");
  closeHint.className = "vg-settings-panel__hint";
  closeHint.textContent = "N OR ESC TO CLOSE";
  panel.appendChild(closeHint);

  document.body.appendChild(overlay);

  let previouslyFocused: HTMLElement | null = null;
  let open = false;

  function setOpen(requestedOpen: boolean): void {
    const nextOpen = requestedOpen && canOpen();
    if (open === nextOpen) return;
    open = nextOpen;
    overlay.style.display = open ? "flex" : "none";
    overlay.setAttribute("aria-hidden", String(!open));
    gearButton.setAttribute("aria-expanded", String(open));
    if (open) {
      // Register modal ownership first. If the Armory is open, this closes
      // it (and performs its own focus restoration) before Settings records
      // where focus should return and moves focus into this dialog.
      onOpenChange?.(true);
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      closeButton.focus();
    } else {
      onOpenChange?.(false);
      if (previouslyFocused) {
        previouslyFocused.focus();
        previouslyFocused = null;
      }
    }
  }

  gearButton.addEventListener("click", () => setOpen(!open));
  closeButton.addEventListener("click", () => setOpen(false));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "n" || e.key === "N") && !e.repeat) setOpen(!open);
    else if (e.key === "Escape" && open) setOpen(false);
  });

  return {
    toggle() {
      setOpen(!open);
    },
    setOpen,
  };
}
