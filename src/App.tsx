// Window router: ?window=dock | toast | picker | settings
// `dock` and `toast` live for the whole session; `picker` and `settings` are created on demand
// by the backend and destroyed when closed (see window_manager::open_modal).

import { useEffect } from "react";
import { DockContainer } from "./components/DockContainer";
import { SettingsModal } from "./components/SettingsModal";
import { ToastOverlay } from "./components/ToastOverlay";
import { WidgetPickerModal } from "./components/WidgetPickerModal";
import { AutomationEngine } from "./engine/AutomationEngine";
import { startHub } from "./engine/DataHub";
import { applyTheme } from "./engine/ThemeEngine";
import { I18nProvider, normalizeLang } from "./i18n";
import { useSettings } from "./lib/hooks";
import { broadcast, subscribe } from "./lib/ipc";

export type WindowKind = "dock" | "toast" | "picker" | "settings";

export function currentWindow(): WindowKind {
  const w = new URLSearchParams(window.location.search).get("window");
  return w === "toast" || w === "picker" || w === "settings" ? w : "dock";
}

function useThemeSync(): void {
  const settings = useSettings();
  useEffect(() => {
    if (settings) applyTheme(settings.theme, settings.size, settings.accent);
  }, [settings]);
}

function DockWindow() {
  useEffect(() => {
    const stopHub = startHub({ calendarTicks: true });
    const stopEngine = AutomationEngine.start();
    const offTest = subscribe("automation:test", ({ rule }) => {
      const result = AutomationEngine.test(rule);
      void broadcast("automation:test-result", { rule, ...result });
    });
    const offReset = subscribe("automation:reset", () => AutomationEngine.resetHistory());
    return () => {
      offTest();
      offReset();
      stopEngine();
      stopHub();
    };
  }, []);
  return <DockContainer />;
}

function PlainWindow(props: { children: React.ReactNode }) {
  useEffect(() => startHub(), []);
  return <>{props.children}</>;
}

function WindowContent({ kind }: { kind: WindowKind }) {
  switch (kind) {
    case "toast":
      return (
        <PlainWindow>
          <ToastOverlay />
        </PlainWindow>
      );
    case "picker":
      return (
        <PlainWindow>
          <WidgetPickerModal />
        </PlainWindow>
      );
    case "settings":
      return (
        <PlainWindow>
          <SettingsModal />
        </PlainWindow>
      );
    default:
      return <DockWindow />;
  }
}

export default function App() {
  useThemeSync();
  const settings = useSettings();
  const kind = currentWindow();
  useEffect(() => {
    document.documentElement.dataset.window = kind;
    // Native context menu would look foreign in every lumabar window.
    const block = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, [kind]);

  // French until settings arrive (it is the first-launch default); switches live afterwards.
  return (
    <I18nProvider lang={normalizeLang(settings?.language)}>
      <WindowContent kind={kind} />
    </I18nProvider>
  );
}
