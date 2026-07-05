// M5: minimal settings overlay — master/sfx/announcer volume sliders + a
// mute-when-tab-hidden checkbox, toggled by a gear icon (top-right) or the
// N key. Persists via audio/settings.ts's loadVolumeSettings/saveVolumeSettings.
import type { VolumeSettings } from "./audio/settings.js";

export interface SettingsOverlay {
  toggle(): void;
}

export function createSettingsOverlay(initial: VolumeSettings, onChange: (settings: VolumeSettings) => void): SettingsOverlay {
  const current: VolumeSettings = { ...initial };

  const gearButton = document.createElement("button");
  gearButton.textContent = "⚙"; // gear glyph
  gearButton.title = "Audio settings (N)";
  gearButton.style.position = "fixed";
  gearButton.style.top = "8px";
  gearButton.style.right = "8px";
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
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "22";
  overlay.style.display = "none";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(0,0,0,0.55)";
  overlay.style.font = "14px monospace";
  overlay.style.color = "#fff";

  const panel = document.createElement("div");
  panel.style.background = "#1c1f24";
  panel.style.border = "1px solid #444";
  panel.style.borderRadius = "6px";
  panel.style.padding = "16px 20px";
  panel.style.minWidth = "280px";
  overlay.appendChild(panel);

  const title = document.createElement("div");
  title.textContent = "AUDIO SETTINGS (N or Esc to close)";
  title.style.marginBottom = "10px";
  title.style.opacity = "0.8";
  panel.appendChild(title);

  function addSlider(label: string, key: "master" | "sfx" | "announcer"): void {
    const row = document.createElement("div");
    row.style.marginBottom = "10px";
    const rowLabel = document.createElement("div");
    rowLabel.textContent = `${label}: ${Math.round(current[key] * 100)}%`;
    row.appendChild(rowLabel);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(current[key] * 100));
    slider.style.width = "100%";
    slider.addEventListener("input", () => {
      const v = Math.max(0, Math.min(1, Number(slider.value) / 100));
      current[key] = v;
      rowLabel.textContent = `${label}: ${Math.round(v * 100)}%`;
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

  document.body.appendChild(overlay);

  function setOpen(open: boolean): void {
    overlay.style.display = open ? "flex" : "none";
  }

  gearButton.addEventListener("click", () => setOpen(overlay.style.display === "none"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "n" || e.key === "N") setOpen(overlay.style.display === "none");
    else if (e.key === "Escape" && overlay.style.display !== "none") setOpen(false);
  });

  return {
    toggle() {
      setOpen(overlay.style.display === "none");
    },
  };
}
