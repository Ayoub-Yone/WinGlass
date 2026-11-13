// System telemetry & quick toggles: Wi-Fi / Bluetooth / Hotspot / Focus (DND) pills, live
// sparklines for CPU, RAM, CPU temperature, network, battery, free storage, keyboard layout.

import {
  ArrowDown,
  ArrowUp,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  Bluetooth,
  Cpu,
  HardDrive,
  Keyboard,
  MemoryStick,
  Moon,
  RadioTower,
  Thermometer,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Sparkline, WidgetCard } from "../components/ui";
import { formatBytesPerSecond, formatGb } from "../lib/format";
import { broadcast, errorMessage, ipc } from "../lib/ipc";
import { patchSettings, usePreview, useSettings, useTelemetry } from "../lib/hooks";
import type { TelemetrySample, WidgetProps } from "../types/lumabar";

// ---------------------------------------------------------------- quick toggles

function TogglePill(props: { icon: LucideIcon; label: string; on: boolean | null; busy: boolean; onClick: () => void; showLabel: boolean }) {
  const { icon: Icon, label, on, busy, onClick, showLabel } = props;
  const unavailable = on === null;
  return (
    <button
      className="lb-icon-btn lb-focus flex h-full min-w-0 flex-1 flex-col gap-0.5 rounded-[10px]"
      title={unavailable ? `${label} unavailable on this PC` : `${label} ${on ? "on" : "off"}`}
      disabled={unavailable || busy}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        background: on ? "var(--lb-accent)" : "transparent",
        color: on ? "#fff" : unavailable ? "var(--lb-faint)" : "var(--lb-text)",
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Icon size={15} strokeWidth={2.2} />
      {showLabel && <span style={{ fontSize: "calc(var(--lb-small) - 1px)", lineHeight: 1 }}>{label}</span>}
    </button>
  );
}

export function QuickTogglesWidget({ span }: WidgetProps) {
  const telemetry = useTelemetry();
  const settings = useSettings();
  const preview = usePreview();
  const [busy, setBusy] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const radios = telemetry[telemetry.length - 1]?.radios ?? { wifi: null, bluetooth: null, hotspot: null };

  const state = (key: "wifi" | "bluetooth" | "hotspot") => (key in optimistic ? optimistic[key] : radios[key]);

  const toggle = async (key: "wifi" | "bluetooth" | "hotspot") => {
    if (preview) return;
    const next = !state(key);
    setBusy(key);
    setOptimistic((o) => ({ ...o, [key]: next }));
    try {
      if (key === "hotspot") await ipc.setHotspot(next);
      else await ipc.setRadio(key, next);
    } catch (err) {
      void broadcast("toast:push", { id: `toggle-${key}`, kind: "system", title: `Couldn't change ${key === "wifi" ? "Wi-Fi" : key}`, subtitle: errorMessage(err) });
    } finally {
      setBusy(null);
      // Let the next telemetry sample become the source of truth again.
      window.setTimeout(() => setOptimistic((o) => {
        const copy = { ...o };
        delete copy[key];
        return copy;
      }), 3000);
    }
  };

  const showLabel = span === "3x1";
  return (
    <WidgetCard span={span} padded={false} className="gap-1 p-1">
      <TogglePill icon={Wifi} label="Wi-Fi" on={state("wifi")} busy={busy === "wifi"} onClick={() => void toggle("wifi")} showLabel={showLabel} />
      <TogglePill icon={Bluetooth} label="Bluetooth" on={state("bluetooth")} busy={busy === "bluetooth"} onClick={() => void toggle("bluetooth")} showLabel={showLabel} />
      <TogglePill icon={RadioTower} label="Hotspot" on={state("hotspot")} busy={busy === "hotspot"} onClick={() => void toggle("hotspot")} showLabel={showLabel} />
      <TogglePill
        icon={Moon}
        label="Focus"
        on={settings?.doNotDisturb ?? false}
        busy={false}
        showLabel={showLabel}
        onClick={() => !preview && void patchSettings((s) => ({ ...s, doNotDisturb: !s.doNotDisturb }))}
      />
    </WidgetCard>
  );
}

// ---------------------------------------------------------------- hardware metrics

interface MetricSpec {
  icon: LucideIcon;
  label: string;
  color: string;
  value: (s: TelemetrySample) => number | null;
  format: (s: TelemetrySample) => ReactNode;
  max?: (s: TelemetrySample) => number;
}

function batteryIcon(s: TelemetrySample): LucideIcon {
  if (s.charging) return BatteryCharging;
  const p = s.batteryPercent ?? 100;
  return p > 70 ? BatteryFull : p > 30 ? BatteryMedium : BatteryLow;
}

const METRICS: Record<string, MetricSpec> = {
  cpu: { icon: Cpu, label: "CPU", color: "var(--lb-accent)", value: (s) => s.cpuPercent, format: (s) => `${Math.round(s.cpuPercent)}%`, max: () => 100 },
  ram: {
    icon: MemoryStick,
    label: "RAM",
    color: "var(--lb-purple)",
    value: (s) => s.ramUsedGb,
    format: (s) => `${s.ramUsedGb.toFixed(1)} GB`,
    max: (s) => s.ramTotalGb,
  },
  temp: {
    icon: Thermometer,
    label: "CPU Temp",
    color: "var(--lb-amber)",
    value: (s) => s.cpuTempC,
    format: (s) => (s.cpuTempC === null ? "—" : `${Math.round(s.cpuTempC)}°C`),
  },
  network: {
    icon: ArrowDown,
    label: "Network",
    color: "var(--lb-green)",
    value: (s) => s.netDownBps,
    format: (s) => (
      <span className="flex flex-col leading-[1.05]" style={{ fontSize: "var(--lb-small)" }}>
        <span className="flex items-center gap-0.5">
          <ArrowDown size={9} />
          {formatBytesPerSecond(s.netDownBps)}
        </span>
        <span className="flex items-center gap-0.5 lb-muted">
          <ArrowUp size={9} />
          {formatBytesPerSecond(s.netUpBps)}
        </span>
      </span>
    ),
  },
  battery: {
    icon: BatteryFull,
    label: "Battery",
    color: "var(--lb-green)",
    value: (s) => s.batteryPercent,
    format: (s) => (s.batteryPercent === null ? "AC" : `${s.batteryPercent}%`),
    max: () => 100,
  },
  storage: {
    icon: HardDrive,
    label: "Free Storage",
    color: "var(--lb-accent)",
    value: (s) => s.diskFreeGb,
    format: (s) => formatGb(s.diskFreeGb),
    max: (s) => s.diskTotalGb,
  },
};

function HardwareMetricWidget(props: WidgetProps & { metric: keyof typeof METRICS }) {
  const { span, metric } = props;
  const spec = METRICS[metric];
  const history = useTelemetry();
  const last = history[history.length - 1];
  const Icon = metric === "battery" && last ? batteryIcon(last) : spec.icon;
  const values = history.map(spec.value).filter((v): v is number => v !== null);
  const max = last && spec.max ? spec.max(last) : undefined;

  if (metric === "storage" && last) {
    const usedPct = last.diskTotalGb > 0 ? 100 - (last.diskFreeGb / last.diskTotalGb) * 100 : 0;
    return (
      <WidgetCard span={span} title={`${formatGb(last.diskFreeGb)} free of ${formatGb(last.diskTotalGb)}`}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <Icon size={16} className="shrink-0" style={{ color: spec.color }} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate font-semibold tabular-nums">{spec.format(last)}</div>
            <div className="mt-1 h-[4px] w-full overflow-hidden rounded-full" style={{ background: "var(--lb-track)" }}>
              <div className="h-full rounded-full" style={{ width: `${usedPct}%`, background: usedPct > 90 ? "var(--lb-red)" : spec.color }} />
            </div>
          </div>
        </div>
      </WidgetCard>
    );
  }

  return (
    <WidgetCard span={span} title={spec.label}>
      <div className="flex w-full min-w-0 items-center gap-2">
        <Icon size={16} className="shrink-0" style={{ color: spec.color }} />
        <div className="min-w-0 shrink-0 leading-tight">
          <div className="font-semibold tabular-nums">{last ? spec.format(last) : "—"}</div>
          {metric !== "network" && (
            <div className="lb-muted" style={{ fontSize: "var(--lb-small)" }}>
              {spec.label}
            </div>
          )}
        </div>
        {span !== "1x1" && (
          <div className="ml-auto min-w-0">
            <Sparkline values={values.slice(-40)} width={span === "3x1" ? 170 : 72} height={22} color={spec.color} max={max} />
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

export const CpuWidget = (p: WidgetProps) => <HardwareMetricWidget {...p} metric="cpu" />;
export const RamWidget = (p: WidgetProps) => <HardwareMetricWidget {...p} metric="ram" />;
export const TempWidget = (p: WidgetProps) => <HardwareMetricWidget {...p} metric="temp" />;
export const NetworkWidget = (p: WidgetProps) => <HardwareMetricWidget {...p} metric="network" />;
export const BatteryWidget = (p: WidgetProps) => <HardwareMetricWidget {...p} metric="battery" />;
export const StorageWidget = (p: WidgetProps) => <HardwareMetricWidget {...p} metric="storage" />;

export function KeyboardLayoutWidget({ span }: WidgetProps) {
  const history = useTelemetry();
  const preview = usePreview();
  const layout = history[history.length - 1]?.keyboardLayout ?? "—";
  return (
    <WidgetCard
      span={span}
      title="Input language — click to switch"
      onClick={() => !preview && void ipc.cycleKeyboardLayout().catch(() => undefined)}
    >
      <div className="flex w-full items-center justify-center gap-1.5">
        <Keyboard size={15} className="lb-muted" />
        <span className="font-semibold tracking-wide">{layout}</span>
      </div>
    </WidgetCard>
  );
}
