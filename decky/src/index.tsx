import { callable, definePlugin } from "@decky/api";
import { ButtonItem, DropdownItem, Field, PanelSection, PanelSectionRow, SliderField, TextField, ToggleField } from "@decky/ui";
import { Component, type ReactNode } from "react";
import { FaMicrochip } from "react-icons/fa";

type Level = "ok" | "warn" | "error" | "checking";

type Status = {
  ok: boolean;
  level?: Level;
  title?: string;
  error?: string;
  gpu_name?: string;
  gpu_id?: string;
  profile_ok?: boolean;
  overdrive_ok?: boolean;
  applied_ok?: boolean;
  applied_state?: "verified" | "partial" | "mismatch";
  applied?: GpuConfig & {
    zero_rpm?: boolean;
    gpu_voltage?: number;
    vram_clock?: number;
  };
  system?: {
    amdgpu_overdrive_enabled?: boolean;
    kernel_version?: string;
  };
  desired?: GpuConfig;
  config?: GpuConfig;
  stats?: {
    clockspeed?: {
      gpu_clockspeed?: number;
      target_gpu_clockspeed?: number;
      vram_clockspeed?: number;
    };
    voltage?: {
      gpu?: number;
      sensors?: Record<string, number>;
    };
    power?: {
      average?: number;
      current?: number;
      cap_current?: number;
      cap_max?: number;
      cap_min?: number;
    };
    temps?: Record<string, { current?: number; crit?: number } | number>;
    fan?: {
      control_enabled?: boolean;
      control_mode?: string;
      static_speed?: number;
      curve?: Record<string, number>;
      speed_current?: number;
      pwm_current?: number;
      speed_max?: number;
      speed_min?: number;
      pwm_max?: number;
      pwm_min?: number;
    };
    busy_percent?: number;
    performance_level?: string;
    throttle_info?: Record<string, string[]>;
  };
  health_status?: string;
  health_log?: string;
  current_profile?: string;
  lact_current_profile?: string | null;
  lact_auto_switch?: boolean;
  profiles?: ProfileSummary[];
  limits?: {
    power_cap?: NumericRange;
    max_memory_clock?: NumericRange;
    voltage_offset?: NumericRange;
  };
};

type GpuConfig = {
  fan_control_enabled?: boolean;
  fan_control_settings?: {
    mode?: string;
    static_speed?: number;
    curve?: Record<string, number>;
  };
  pmfw_options?: {
    zero_rpm?: boolean;
  };
  power_cap?: number;
  performance_level?: string;
  max_memory_clock?: number;
  voltage_offset?: number;
};

type ProfileSummary = {
  id: string;
  name: string;
  source?: "lact" | "toolkit";
  power_cap?: number;
  voltage_offset?: number;
  max_memory_clock?: number;
  custom?: boolean;
};

type NumericRange = {
  min?: number;
  max?: number;
  default?: number;
};

type FanMode = "automatic" | "static" | "curve";

type FanDraft = {
  mode: FanMode;
  static_speed: number;
  zero_rpm: boolean;
};

const getStatus = callable<[], Status>("get_status");
const applyProfile = callable<[string], Status>("apply_profile");
const applyCustomConfig = callable<[GpuConfig], Status>("apply_custom_config");
const applyFanControl = callable<[FanDraft], Status>("apply_fan_control");
const saveCustomProfile = callable<[string, GpuConfig], Status>("save_custom_profile");
const deleteCustomProfile = callable<[string], Status>("delete_custom_profile");

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

function colorFor(level: Level): string {
  if (level === "ok") return "#59bf6b";
  if (level === "warn") return "#d9a441";
  if (level === "error") return "#d85c5c";
  return "#8a98a8";
}

function fmt(value: number | undefined, suffix: string, digits = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(digits)}${suffix}`;
}

function tempValue(value: { current?: number } | number | undefined): number | undefined {
  if (typeof value === "number") return value;
  return value?.current;
}

function rangeMin(range: NumericRange | undefined, fallback: number): number {
  return Math.round(range?.min ?? fallback);
}

function rangeMax(range: NumericRange | undefined, fallback: number): number {
  return Math.round(range?.max ?? fallback);
}

function StatusCard({ status }: { status: Status | null }) {
  const level = status?.level ?? (status ? "error" : "checking");
  const color = colorFor(level);
  let title = status?.title ?? "Checking";
  let detail = "Reading LACT status...";
  const selectedProfile = status?.profiles?.find((profile) => profile.id === status.current_profile);
  const selectedLabel =
    selectedProfile?.source === "lact"
      ? `LACT profile "${selectedProfile.name}"`
      : selectedProfile?.source === "toolkit"
        ? `Toolkit preset "${selectedProfile.name}"`
        : undefined;

  if (status?.ok) {
    if (status.profile_ok && status.overdrive_ok) {
      if (status.applied_ok) {
        detail = selectedLabel
          ? `${selectedLabel} matches the driver runtime values.`
          : "Current LACT config matches the driver runtime values.";
      } else if (status.applied_state === "partial") {
        detail = selectedLabel
          ? `${selectedLabel} is active; some runtime values are not reported by LACT on this system.`
          : "Current LACT config is active; some runtime values are not reported by LACT on this system.";
      } else {
        detail = selectedLabel
          ? `${selectedLabel} is selected, but runtime values do not match.`
          : "Current LACT config is saved, but runtime values do not match.";
      }
    } else if (!status.profile_ok) {
      detail = "Saved LACT values do not match any known profile.";
    } else if (!status.overdrive_ok) {
      detail = "Profile is saved, but kernel overdrive is not active.";
    }
  } else if (status?.error) {
    title = "Error";
    detail = status.error;
  }

  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
      <div
        style={{
          width: "11px",
          height: "11px",
          borderRadius: "50%",
          background: color,
          marginTop: "5px",
          flex: "0 0 auto",
        }}
      />
      <div>
        <div style={{ color, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: "12px", opacity: 0.78, lineHeight: 1.35 }}>{detail}</div>
      </div>
    </div>
  );
}

function FocusStop({ children }: { children: ReactNode }) {
  return (
    <Field focusable highlightOnFocus bottomSeparator="none" padding="none" childrenLayout="below">
      {children}
    </Field>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "12px", lineHeight: 1.45 }}>
      <span style={{ opacity: 0.72 }}>{label}</span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

function MetricGrid({ status }: { status: Status }) {
  const temps = status.stats?.temps ?? {};
  const throttle = status.stats?.throttle_info ?? {};
  const throttleText = Object.keys(throttle).length ? Object.keys(throttle).join(", ") : "No";
  const fan = status.stats?.fan ?? {};
  const fanMode = fan.control_enabled ? fan.control_mode ?? "manual" : "auto";

  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <KV label="Edge / Junction" value={`${fmt(tempValue(temps.edge), " C")} / ${fmt(tempValue(temps.junction), " C")}`} />
      <KV label="Memory / VRM" value={`${fmt(tempValue(temps.mem), " C")} / ${fmt(tempValue(temps.vrmem), " C")}`} />
      <KV label="GPU" value={`${fmt(status.stats?.clockspeed?.gpu_clockspeed, " MHz")} / ${fmt(status.stats?.voltage?.gpu, " mV")}`} />
      <KV label="Power" value={`${fmt(status.stats?.power?.average, " W")} / cap ${fmt(status.stats?.power?.cap_current, " W")}`} />
      <KV label="Fan" value={`${fmt(fan.speed_current, " RPM")} (${fanMode})`} />
      <KV label="Busy / Throttle" value={`${fmt(status.stats?.busy_percent, "%")} / ${throttleText}`} />
    </div>
  );
}

function VerificationGrid({ status }: { status: Status }) {
  const config = status.config ?? {};
  const desired = status.desired ?? {};
  const applied = status.applied ?? {};
  const selectedProfile = status.profiles?.find((profile) => profile.id === status.current_profile);
  const profileText = selectedProfile
    ? `${selectedProfile.source === "lact" ? "LACT" : "Toolkit"}: ${selectedProfile.name}`
    : "Current LACT config";
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <KV label="Overdrive" value={status.overdrive_ok ? "Active" : "Inactive"} />
      <KV label="Profile" value={profileText} />
      <KV label="LACT current" value={status.lact_current_profile ?? "Default config"} />
      <KV label="Applied" value={status.applied_ok ? "Verified" : status.applied_state === "partial" ? "Partial" : "Mismatch"} />
      <KV label="Power cap" value={`${config.power_cap ?? "n/a"} -> ${applied.power_cap ?? "n/a"} W (target ${desired.power_cap ?? "n/a"})`} />
      <KV label="Undervolt" value={`${config.voltage_offset ?? "n/a"} -> ${applied.voltage_offset ?? "n/a"} mV (target ${desired.voltage_offset ?? "n/a"})`} />
      <KV label="VRAM max" value={`${config.max_memory_clock ?? "n/a"} -> ${applied.max_memory_clock ?? "n/a"} MHz`} />
      <KV label="Zero RPM" value={`${config.pmfw_options?.zero_rpm ? "On" : "Off"} -> ${applied.zero_rpm ? "On" : "Off"}`} />
    </div>
  );
}

type ContentState = {
  status: Status | null;
  busy: boolean;
  dirty: boolean;
  fanDirty: boolean;
  errorSticky: boolean;
  draft: GpuConfig | null;
  fanDraft: FanDraft | null;
  presetName: string;
};

class Content extends Component<Record<string, never>, ContentState> {
  private timer: number | undefined;

  state: ContentState = {
    status: {
      ok: false,
      level: "warn",
      title: "Checking LACT status",
      error: "Waiting for the first LACT status read.",
    },
    busy: false,
    dirty: false,
    fanDirty: false,
    errorSticky: false,
    draft: null,
    fanDraft: null,
    presetName: "Custom",
  };

  componentDidMount() {
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 5000);
  }

  componentWillUnmount() {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
    }
  }

  refresh = async () => {
    if (this.state.errorSticky) return;
    try {
      const status = await withTimeout(getStatus(), "get_status");
      this.setState((state) => ({
        status,
        draft: !state.dirty && status.ok ? this.draftFromStatus(status) : state.draft,
        fanDraft: !state.fanDirty && status.ok ? this.fanDraftFromStatus(status) : state.fanDraft,
      }));
    } catch (error) {
      this.setState({
        status: {
          ok: false,
          level: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  run = async (action: () => Promise<Status>, clear: "all" | "tuning" | "fan" = "all") => {
    this.setState({ busy: true });
    try {
      try {
        const status = await withTimeout(action(), "action");
        this.setState({
          status,
          draft: status.ok && clear !== "fan" ? this.draftFromStatus(status) : this.state.draft,
          fanDraft: status.ok && clear !== "tuning" ? this.fanDraftFromStatus(status) : this.state.fanDraft,
          dirty: clear === "fan" ? this.state.dirty : false,
          fanDirty: clear === "tuning" ? this.state.fanDirty : false,
          errorSticky: false,
        });
      } catch (error) {
        this.setState({
          status: {
            ok: false,
            level: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          errorSticky: true,
        });
        window.setTimeout(() => {
          this.setState({ errorSticky: false });
          void this.refresh();
        }, 10000);
      }
    } finally {
      this.setState({ busy: false });
    }
  };

  draftFromStatus(status: Status): GpuConfig {
    const config = status.config ?? status.desired ?? {};
    return {
      pmfw_options: { zero_rpm: config.pmfw_options?.zero_rpm ?? true },
      power_cap: config.power_cap ?? 0,
      performance_level: "auto",
      max_memory_clock: config.max_memory_clock ?? 0,
      voltage_offset: config.voltage_offset ?? 0,
    };
  }

  fanDraftFromStatus(status: Status): FanDraft {
    const config = status.config ?? {};
    const fan = status.stats?.fan ?? {};
    const enabled = config.fan_control_enabled ?? fan.control_enabled ?? false;
    const mode = enabled ? String(config.fan_control_settings?.mode ?? fan.control_mode ?? "static") : "automatic";
    const staticSpeed = config.fan_control_settings?.static_speed ?? fan.static_speed ?? 0.5;
    return {
      mode: mode === "curve" ? "curve" : mode === "static" ? "static" : "automatic",
      static_speed: Math.round(Math.max(0, Math.min(staticSpeed, 1)) * 100),
      zero_rpm: config.pmfw_options?.zero_rpm ?? true,
    };
  }

  updateDraft = (patch: Partial<GpuConfig>) => {
    this.setState((state) => ({
      dirty: true,
      errorSticky: false,
      draft: {
        ...(state.draft ?? this.draftFromStatus(state.status ?? { ok: false })),
        ...patch,
        pmfw_options: patch.pmfw_options ?? state.draft?.pmfw_options ?? { zero_rpm: true },
      },
    }));
  };

  updateFanDraft = (patch: Partial<FanDraft>) => {
    this.setState((state) => ({
      fanDirty: true,
      errorSticky: false,
      fanDraft: {
        ...(state.fanDraft ?? this.fanDraftFromStatus(state.status ?? { ok: false })),
        ...patch,
      },
    }));
  };

  applyFanDraft = (patch: Partial<FanDraft>) => {
    const next = {
      ...(this.state.fanDraft ?? this.fanDraftFromStatus(this.state.status ?? { ok: false })),
      ...patch,
    };
    this.setState({ fanDraft: next, fanDirty: false, errorSticky: false });
    void this.run(() => applyFanControl({ ...next, static_speed: next.static_speed / 100 }), "fan");
  };

  render() {
    const { status, busy, dirty, fanDirty, draft, fanDraft, presetName } = this.state;
    const profiles = status?.profiles ?? [];
    const profileOptions = [{ data: "__current", label: "Current LACT config" }, ...profiles.map((profile) => ({
      data: profile.id,
      label: `${profile.source === "lact" ? "LACT" : "Toolkit"}: ${profile.name} ${fmt(profile.power_cap, " W")} / ${fmt(profile.voltage_offset, " mV")}`,
    }))];
    const selectedProfile = status?.current_profile && status.current_profile !== "custom" ? status.current_profile : "__current";
    const selectedProfileInfo = profiles.find((profile) => profile.id === selectedProfile);
    const edit = draft ?? this.draftFromStatus(status ?? { ok: false });
    const fanEdit = fanDraft ?? this.fanDraftFromStatus(status ?? { ok: false });
    const powerMin = rangeMin(status?.limits?.power_cap, status?.stats?.power?.cap_min ?? 0);
    const powerMax = rangeMax(status?.limits?.power_cap, status?.stats?.power?.cap_max ?? Math.max(edit.power_cap ?? 0, 1));
    const memoryMin = rangeMin(status?.limits?.max_memory_clock, 0);
    const memoryMax = rangeMax(status?.limits?.max_memory_clock, Math.max(edit.max_memory_clock ?? 0, 1));
    const voltageMin = rangeMin(status?.limits?.voltage_offset, -300);
    const voltageMax = rangeMax(status?.limits?.voltage_offset, 0);

    return (
      <>
        <PanelSection title="Status">
          <PanelSectionRow>
            <FocusStop>
              <StatusCard status={status} />
            </FocusStop>
          </PanelSectionRow>
        </PanelSection>

        {status?.ok && (
          <>
            <PanelSection title="Live GPU">
              <PanelSectionRow>
                <FocusStop>
                  <MetricGrid status={status} />
                </FocusStop>
              </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Verification">
              <PanelSectionRow>
                <FocusStop>
                  <VerificationGrid status={status} />
                </FocusStop>
              </PanelSectionRow>
              <PanelSectionRow>
                <DropdownItem
                  label="Profile"
                  rgOptions={profileOptions}
                  selectedOption={selectedProfile}
                  disabled={busy}
                  onChange={(entry) => {
                    const profileId = String(entry.data);
                    if (profileId !== "__current") void this.run(() => applyProfile(profileId));
                  }}
                />
              </PanelSectionRow>
              {selectedProfileInfo?.custom && (
                <PanelSectionRow>
                  <ButtonItem layout="below" disabled={busy} onClick={() => void this.run(() => deleteCustomProfile(selectedProfile))}>
                    Delete Toolkit preset
                  </ButtonItem>
                </PanelSectionRow>
              )}
            </PanelSection>

            <PanelSection title="Custom Tuning">
              <PanelSectionRow>
                <SliderField
                  label="Power cap"
                  value={Math.round(edit.power_cap ?? powerMin)}
                  min={powerMin}
                  max={powerMax}
                  step={1}
                  showValue
                  editableValue
                  valueSuffix=" W"
                  disabled={busy}
                  onChange={(value) => this.updateDraft({ power_cap: value })}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <SliderField
                  label="Undervolt"
                  value={Math.round(edit.voltage_offset ?? 0)}
                  min={voltageMin}
                  max={voltageMax}
                  step={5}
                  showValue
                  editableValue
                  valueSuffix=" mV"
                  disabled={busy}
                  onChange={(value) => this.updateDraft({ voltage_offset: value })}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <SliderField
                  label="VRAM max"
                  value={Math.round(edit.max_memory_clock ?? memoryMax)}
                  min={memoryMin}
                  max={memoryMax}
                  step={1}
                  showValue
                  editableValue
                  valueSuffix=" MHz"
                  disabled={busy}
                  onChange={(value) => this.updateDraft({ max_memory_clock: value })}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem layout="below" disabled={busy || !dirty} onClick={() => void this.run(() => applyCustomConfig(edit), "tuning")}>
                  Apply custom
                </ButtonItem>
              </PanelSectionRow>
              <PanelSectionRow>
                <TextField
                  label="Preset name"
                  value={presetName}
                  disabled={busy}
                  onChange={(event) => this.setState({ presetName: event.currentTarget.value })}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem layout="below" disabled={busy} onClick={() => void this.run(() => saveCustomProfile(presetName, edit))}>
                  Save preset
                </ButtonItem>
              </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Fan Control">
              <PanelSectionRow>
                <DropdownItem
                  label="Mode"
                  rgOptions={[
                    { data: "automatic", label: "Automatic (GPU default)" },
                    { data: "static", label: "Static speed" },
                    { data: "curve", label: "LACT curve" },
                  ]}
                  selectedOption={fanEdit.mode}
                  disabled={busy}
                  onChange={(entry) => this.applyFanDraft({ mode: String(entry.data) as FanMode })}
                />
              </PanelSectionRow>
              {fanEdit.mode === "static" && (
                <PanelSectionRow>
                  <SliderField
                    label="Static fan speed"
                    value={fanEdit.static_speed}
                    min={0}
                    max={100}
                    step={1}
                    showValue
                    editableValue
                    valueSuffix="%"
                    disabled={busy}
                    onChange={(value) => this.updateFanDraft({ static_speed: value })}
                  />
                </PanelSectionRow>
              )}
              <PanelSectionRow>
                <ToggleField
                  label="Zero RPM"
                  checked={fanEdit.zero_rpm}
                  disabled={busy}
                  onChange={(checked) => this.updateFanDraft({ zero_rpm: checked })}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  disabled={busy || !fanDirty}
                  onClick={() => void this.run(() => applyFanControl({ ...fanEdit, static_speed: fanEdit.static_speed / 100 }), "fan")}
                >
                  Apply fan settings
                </ButtonItem>
              </PanelSectionRow>
            </PanelSection>
          </>
        )}
      </>
    );
  }
}

export default definePlugin(() => {
  return {
    name: "SteamOS LACT Toolkit",
    titleView: <div>SteamOS LACT Toolkit</div>,
    content: <Content />,
    icon: <FaMicrochip />,
  };
});
