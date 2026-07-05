import { callable, definePlugin } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, TextField, ToggleField } from "@decky/ui";
import { Component } from "react";
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
      speed_current?: number;
      pwm_current?: number;
    };
    busy_percent?: number;
    performance_level?: string;
    throttle_info?: Record<string, string[]>;
  };
  health_status?: string;
  health_log?: string;
  current_profile?: string;
  profiles?: ProfileSummary[];
};

type GpuConfig = {
  fan_control_enabled?: boolean;
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
  power_cap: number;
  voltage_offset: number;
  max_memory_clock: number;
  custom?: boolean;
};

const getStatus = callable<[], Status>("get_status");
const applyProfile = callable<[string], Status>("apply_profile");
const applyCustomConfig = callable<[GpuConfig], Status>("apply_custom_config");
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

function StatusCard({ status }: { status: Status | null }) {
  const level = status?.level ?? (status ? "error" : "checking");
  const color = colorFor(level);
  let title = status?.title ?? "Checking";
  let detail = "Reading LACT status...";

  if (status?.ok) {
    if (status.profile_ok && status.overdrive_ok) {
      detail = status.applied_ok
        ? "Selected profile matches the driver runtime values."
        : "Selected profile is saved, but runtime values do not match.";
    } else if (!status.profile_ok) {
      detail = "Saved LACT values do not match any saved preset.";
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

  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <KV label="Edge / Junction" value={`${fmt(tempValue(temps.edge), " C")} / ${fmt(tempValue(temps.junction), " C")}`} />
      <KV label="Memory / VRM" value={`${fmt(tempValue(temps.mem), " C")} / ${fmt(tempValue(temps.vrmem), " C")}`} />
      <KV label="GPU" value={`${fmt(status.stats?.clockspeed?.gpu_clockspeed, " MHz")} / ${fmt(status.stats?.voltage?.gpu, " mV")}`} />
      <KV label="Power" value={`${fmt(status.stats?.power?.average, " W")} / cap ${fmt(status.stats?.power?.cap_current, " W")}`} />
      <KV label="Fan" value={`${fmt(status.stats?.fan?.speed_current, " RPM")} (${status.stats?.fan?.control_enabled ? "manual" : "auto"})`} />
      <KV label="Busy / Throttle" value={`${fmt(status.stats?.busy_percent, "%")} / ${throttleText}`} />
    </div>
  );
}

function VerificationGrid({ status }: { status: Status }) {
  const config = status.config ?? {};
  const desired = status.desired ?? {};
  const applied = status.applied ?? {};
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <KV label="Overdrive" value={status.overdrive_ok ? "Active" : "Inactive"} />
      <KV label="Profile" value={status.current_profile ?? (status.profile_ok ? "Configured" : "Mismatch")} />
      <KV label="Applied" value={status.applied_ok ? "Verified" : "Mismatch"} />
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
  draft: GpuConfig | null;
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
    draft: null,
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
    try {
      const status = await withTimeout(getStatus(), "get_status");
      this.setState((state) => ({
        status,
        draft: !state.dirty && status.ok ? this.draftFromStatus(status) : state.draft,
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

  run = async (action: () => Promise<Status>) => {
    this.setState({ busy: true });
    try {
      try {
        const status = await withTimeout(action(), "action");
        this.setState({
          status,
          draft: status.ok ? this.draftFromStatus(status) : this.state.draft,
          dirty: false,
        });
      } catch (error) {
        this.setState({
          status: {
            ok: false,
            level: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } finally {
      this.setState({ busy: false });
    }
  };

  draftFromStatus(status: Status): GpuConfig {
    const config = status.config ?? status.desired ?? {};
    return {
      fan_control_enabled: false,
      pmfw_options: { zero_rpm: config.pmfw_options?.zero_rpm ?? true },
      power_cap: config.power_cap ?? 0,
      performance_level: "auto",
      max_memory_clock: config.max_memory_clock ?? 0,
      voltage_offset: config.voltage_offset ?? 0,
    };
  }

  updateDraft = (patch: Partial<GpuConfig>) => {
    this.setState((state) => ({
      dirty: true,
      draft: {
        ...(state.draft ?? this.draftFromStatus(state.status ?? { ok: false })),
        ...patch,
        pmfw_options: patch.pmfw_options ?? state.draft?.pmfw_options ?? { zero_rpm: true },
      },
    }));
  };

  render() {
    const { status, busy, dirty, draft, presetName } = this.state;
    const profiles = status?.profiles ?? [];
    const profileOptions = profiles.length ? profiles.map((profile) => ({
      data: profile.id,
      label: `${profile.name} ${profile.power_cap} W / ${profile.voltage_offset} mV`,
    })) : [{ data: "__current", label: "Current unsaved values" }];
    const selectedProfile = status?.current_profile && status.current_profile !== "custom" ? status.current_profile : "__current";
    const selectedProfileInfo = profiles.find((profile) => profile.id === selectedProfile);
    const edit = draft ?? this.draftFromStatus(status ?? { ok: false });
    const powerMin = Math.round(status?.stats?.power?.cap_min ?? 0);
    const powerMax = Math.round(status?.stats?.power?.cap_max ?? Math.max(edit.power_cap ?? 0, 1));
    const memoryMax = Math.max(Math.round(status?.applied?.max_memory_clock ?? edit.max_memory_clock ?? 0), 1);

    return (
      <>
        <PanelSection title="Status">
          <PanelSectionRow>
            <StatusCard status={status} />
          </PanelSectionRow>
        </PanelSection>

        {status?.ok && (
          <>
            <PanelSection title="Live GPU">
              <PanelSectionRow>
                <MetricGrid status={status} />
              </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Verification">
              <PanelSectionRow>
                <VerificationGrid status={status} />
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
                    Delete selected preset
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
                  min={-300}
                  max={0}
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
                  min={0}
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
                <ToggleField
                  label="Zero RPM"
                  checked={edit.pmfw_options?.zero_rpm ?? true}
                  disabled={busy}
                  onChange={(checked) => this.updateDraft({ pmfw_options: { zero_rpm: checked } })}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem layout="below" disabled={busy || !dirty} onClick={() => void this.run(() => applyCustomConfig(edit))}>
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
