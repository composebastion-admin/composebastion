import { useCallback, useEffect, useState } from "react";
import { Bell, Clock, Trash2 } from "lucide-react";
import type { AlertChannelTestEvent, AlertEvent, AlertRule, AlertRuleCondition, AlertSilence, DockerHost, HostMetricAlertCondition, NotificationChannel, ResourceSnapshot } from "@composebastion/shared";
import { api, deleteJson, postJson } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { ButtonRow, DataTable, Panel, StatusPill, VirtualDataTable } from "../ui/primitives.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAuthorization } from "../AuthorizationContext.js";

const hostMetricConditionLabels: Record<HostMetricAlertCondition, string> = {
  "host.cpu": "Host CPU",
  "host.memory": "Host memory",
  "host.disk": "Host disk",
  "host.swap": "Host swap",
  "host.load": "Host load"
};

const conditionLabels: Record<AlertRuleCondition, string> = {
  "host.offline": "Host offline",
  "container.not_running": "Container not running",
  ...hostMetricConditionLabels
};

function isHostMetricCondition(condition: AlertRuleCondition): condition is HostMetricAlertCondition {
  return condition in hostMetricConditionLabels;
}

function isPercentMetric(condition: AlertRuleCondition) {
  return condition !== "host.load";
}

function formatDuration(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function thresholdSummary(rule: AlertRule) {
  if (!isHostMetricCondition(rule.condition) || !rule.params) return "";
  const comparator = rule.params.comparator === "gt" ? ">" : ">=";
  const unit = rule.condition === "host.load" ? "" : "%";
  const mount = rule.condition === "host.disk" && rule.params.mount ? `${rule.params.mount} ` : "";
  return `${mount}${comparator} ${rule.params.threshold}${unit} for ${formatDuration(rule.params.durationSeconds)}`;
}

function defaultSilenceEnd() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
}

function toApiDateTime(value: string) {
  return new Date(value).toISOString();
}

export function AlertsPanel({ hosts, containers, refresh }: { hosts: DockerHost[]; containers: ResourceSnapshot[]; refresh: () => Promise<void> }) {
  const { confirm } = useConfirm();
  const { canOperate: canManage } = useAuthorization();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [silences, setSilences] = useState<AlertSilence[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [channelTestEvents, setChannelTestEvents] = useState<AlertChannelTestEvent[]>([]);
  const [channelTestError, setChannelTestError] = useState<string | null>(null);
  const [channelForm, setChannelForm] = useState({ name: "", type: "email", emailTo: "", webhookUrl: "" });
  const [silenceForm, setSilenceForm] = useState({
    name: "",
    scope: "host" as "host" | "rule",
    hostId: hosts[0]?.id ?? "",
    ruleId: "",
    endsAt: defaultSilenceEnd(),
    reason: ""
  });
  const [ruleForm, setRuleForm] = useState({
    name: "",
    condition: "host.offline" as AlertRuleCondition,
    hostId: hosts[0]?.id ?? "",
    containerId: "",
    channelId: "",
    comparator: "gte" as "gt" | "gte",
    threshold: "85",
    durationMinutes: "5",
    mount: ""
  });

  const load = useCallback(async () => {
    const [silenceResult, eventResult, testHistoryResult] = await Promise.all([
      api<{ silences: AlertSilence[] }>("/api/alerts/silences"),
      api<{ events: AlertEvent[] }>("/api/alerts/history?limit=50"),
      api<{ events: AlertChannelTestEvent[] }>("/api/alerts/channels/test-history?limit=20")
    ]);
    setSilences(silenceResult.silences);
    setEvents(eventResult.events);
    setChannelTestEvents(testHistoryResult.events);
    if (!canManage) {
      setChannels([]);
      setRules([]);
      return;
    }
    const [channelResult, ruleResult] = await Promise.all([
      api<{ channels: NotificationChannel[] }>("/api/alerts/channels"),
      api<{ rules: AlertRule[] }>("/api/alerts/rules")
    ]);
    setChannels(channelResult.channels);
    setRules(ruleResult.rules);
  }, [canManage]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!ruleForm.hostId && hosts[0]?.id) setRuleForm((current) => ({ ...current, hostId: hosts[0]!.id }));
  }, [hosts, ruleForm.hostId]);
  useEffect(() => {
    if (!silenceForm.hostId && hosts[0]?.id) setSilenceForm((current) => ({ ...current, hostId: hosts[0]!.id }));
  }, [hosts, silenceForm.hostId]);

  const submitRule = async () => {
    const payload: Record<string, unknown> = {
      name: ruleForm.name,
      condition: ruleForm.condition,
      hostId: ruleForm.hostId,
      channelId: ruleForm.channelId,
      enabled: true
    };
    if (ruleForm.condition === "container.not_running" && ruleForm.containerId) {
      payload.containerId = ruleForm.containerId;
    }
    if (isHostMetricCondition(ruleForm.condition)) {
      const params: Record<string, unknown> = {
        comparator: ruleForm.comparator,
        threshold: Number(ruleForm.threshold),
        durationSeconds: Math.max(1, Math.round(Number(ruleForm.durationMinutes) || 5)) * 60
      };
      if (ruleForm.condition === "host.disk" && ruleForm.mount.trim()) params.mount = ruleForm.mount.trim();
      payload.params = params;
    }
    await postJson("/api/alerts/rules", payload);
    await load();
    await refresh();
  };

  const submitSilence = async () => {
    const payload: Record<string, unknown> = {
      name: silenceForm.name,
      endsAt: toApiDateTime(silenceForm.endsAt),
      reason: silenceForm.reason.trim() || undefined
    };
    if (silenceForm.scope === "rule") payload.ruleId = silenceForm.ruleId;
    else payload.hostId = silenceForm.hostId;
    await postJson("/api/alerts/silences", payload);
    setSilenceForm((current) => ({ ...current, name: "", reason: "", endsAt: defaultSilenceEnd() }));
    await load();
  };

  const testChannel = async (channelId: string) => {
    setChannelTestError(null);
    try {
      await postJson(`/api/alerts/channels/${channelId}/test`, {});
    } catch (caught) {
      setChannelTestError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      await load();
    }
  };

  async function confirmDelete(kind: "rule" | "channel" | "silence", id: string, label: string) {
    const confirmed = await confirm({
      title: `Delete alert ${kind}`,
      tone: "danger",
      confirmLabel: "Delete",
      message: `Delete ${kind} “${label}”? This cannot be undone.`
    });
    if (!confirmed) return;
    await deleteJson(`/api/alerts/${kind === "rule" ? "rules" : kind === "channel" ? "channels" : "silences"}/${id}`);
    await load();
  }

  return (
    <Panel title="Alerts">
      {canManage && (
        <>
          <div className="split">
            <form className="stack" onSubmit={(event) => { event.preventDefault(); void postJson("/api/alerts/channels", { ...channelForm, enabled: true }).then(load); }}>
              <strong>Notification Channel</strong>
              <input placeholder="Name" value={channelForm.name} onChange={(event) => setChannelForm({ ...channelForm, name: event.target.value })} required />
              <select value={channelForm.type} onChange={(event) => setChannelForm({ ...channelForm, type: event.target.value })}>
                <option value="email">Email</option>
                <option value="webhook">Webhook</option>
              </select>
              <input placeholder="Email recipient" value={channelForm.emailTo} onChange={(event) => setChannelForm({ ...channelForm, emailTo: event.target.value })} />
              <input placeholder="Webhook URL" value={channelForm.webhookUrl} onChange={(event) => setChannelForm({ ...channelForm, webhookUrl: event.target.value })} />
              <button className="primary"><Bell size={18} />Save Channel</button>
            </form>
            <form className="stack" onSubmit={(event) => { event.preventDefault(); void submitRule(); }}>
              <strong>Alert Rule</strong>
              <input placeholder="Rule name" value={ruleForm.name} onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })} required />
              <select value={ruleForm.condition} onChange={(event) => {
                const condition = event.target.value as AlertRuleCondition;
                setRuleForm({
                  ...ruleForm,
                  condition,
                  containerId: condition === "container.not_running" ? ruleForm.containerId : "",
                  mount: condition === "host.disk" ? ruleForm.mount : ""
                });
              }}>
                <option value="host.offline">Host offline</option>
                <option value="container.not_running">Container not running</option>
                <option value="host.cpu">Host CPU</option>
                <option value="host.memory">Host memory</option>
                <option value="host.disk">Host disk</option>
                <option value="host.swap">Host swap</option>
                <option value="host.load">Host load</option>
              </select>
              <HostSelect hosts={hosts} value={ruleForm.hostId} onChange={(hostId) => setRuleForm({ ...ruleForm, hostId })} />
              {ruleForm.condition === "container.not_running" && (
                <select value={ruleForm.containerId} onChange={(event) => setRuleForm({ ...ruleForm, containerId: event.target.value })}>
                  <option value="">Container, if needed</option>
                  {containers.map((container) => <option key={container.id} value={container.externalId}>{container.name}</option>)}
                </select>
              )}
              {isHostMetricCondition(ruleForm.condition) && (
                <div className="alertThresholdGrid">
                  <select value={ruleForm.comparator} onChange={(event) => setRuleForm({ ...ruleForm, comparator: event.target.value as "gt" | "gte" })}>
                    <option value="gte">At least</option>
                    <option value="gt">Greater than</option>
                  </select>
                  <label className="inputWithSuffix">
                    <input
                      type="number"
                      min={ruleForm.condition === "host.load" ? 0.01 : 1}
                      max={ruleForm.condition === "host.load" ? 1024 : 100}
                      step={ruleForm.condition === "host.load" ? 0.1 : 1}
                      placeholder="Threshold"
                      value={ruleForm.threshold}
                      onChange={(event) => setRuleForm({ ...ruleForm, threshold: event.target.value })}
                      required
                    />
                    {isPercentMetric(ruleForm.condition) && <span>%</span>}
                  </label>
                  <label className="inputWithSuffix">
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      placeholder="Duration"
                      value={ruleForm.durationMinutes}
                      onChange={(event) => setRuleForm({ ...ruleForm, durationMinutes: event.target.value })}
                      required
                    />
                    <span>min</span>
                  </label>
                  {ruleForm.condition === "host.disk" && (
                    <input placeholder="Mount, optional" value={ruleForm.mount} onChange={(event) => setRuleForm({ ...ruleForm, mount: event.target.value })} />
                  )}
                </div>
              )}
              <select value={ruleForm.channelId} onChange={(event) => setRuleForm({ ...ruleForm, channelId: event.target.value })} required>
                <option value="">Channel</option>
                {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
              </select>
              <button className="primary"><Bell size={18} />Save Rule</button>
            </form>
          </div>
          <DataTable rows={rules} columns={["Name", "Condition", "State", "Actions"]} render={(rule) => [
            rule.name,
            <div key="condition" className="alertRuleCondition">
              <strong>{conditionLabels[rule.condition]}</strong>
              {thresholdSummary(rule) && <small>{thresholdSummary(rule)}</small>}
            </div>,
            <div key="state" className="alertRuleState">
              {rule.lastState ? <StatusPill status={rule.lastState} /> : ""}
              {rule.breachingSince && <small>Breaching since {formatDate(rule.breachingSince)}</small>}
              {rule.lastError && <small className="errorText">{rule.lastError}</small>}
            </div>,
            <button key="delete" className="danger" onClick={() => void confirmDelete("rule", rule.id, rule.name)}><Trash2 size={16} /></button>
          ]} />
          <DataTable rows={channels} columns={["Channel", "Type", "Target", "Actions"]} render={(channel) => [
            channel.name,
            channel.type,
            channel.emailTo ?? channel.webhookUrl ?? "",
            <ButtonRow key="actions"><button onClick={() => void testChannel(channel.id)}>Test</button><button className="danger" onClick={() => void confirmDelete("channel", channel.id, channel.name)}><Trash2 size={16} /></button></ButtonRow>
          ]} />
        </>
      )}
      {channelTestError && <div className="notice error">{channelTestError}</div>}
      <div className="panelSectionTitle">Channel Test History</div>
      <VirtualDataTable rows={channelTestEvents} maxRows={60} columns={["When", "Channel", "Status", "Error"]} render={(event) => [
        formatDate(event.testedAt),
        channels.find((channel) => channel.id === event.channelId)?.name ?? event.channelId,
        <StatusPill key="status" status={event.status} />,
        event.error ?? ""
      ]} />
      <div className="panelSectionTitle">Silences</div>
      {canManage && (
        <form className="inlineForm" onSubmit={(event) => { event.preventDefault(); void submitSilence(); }}>
          <strong>Maintenance window</strong>
          <input placeholder="Name" value={silenceForm.name} onChange={(event) => setSilenceForm({ ...silenceForm, name: event.target.value })} required />
          <select value={silenceForm.scope} onChange={(event) => setSilenceForm({ ...silenceForm, scope: event.target.value as "host" | "rule" })}>
            <option value="host">Host</option>
            <option value="rule">Rule</option>
          </select>
          {silenceForm.scope === "host" ? (
            <HostSelect hosts={hosts} value={silenceForm.hostId} onChange={(hostId) => setSilenceForm({ ...silenceForm, hostId })} />
          ) : (
            <select value={silenceForm.ruleId} onChange={(event) => setSilenceForm({ ...silenceForm, ruleId: event.target.value })} required>
              <option value="">Rule</option>
              {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
            </select>
          )}
          <input type="datetime-local" value={silenceForm.endsAt} onChange={(event) => setSilenceForm({ ...silenceForm, endsAt: event.target.value })} required />
          <input placeholder="Reason, optional" value={silenceForm.reason} onChange={(event) => setSilenceForm({ ...silenceForm, reason: event.target.value })} />
          <button className="primary"><Clock size={16} />Silence</button>
        </form>
      )}
      <VirtualDataTable rows={silences} maxRows={80} columns={canManage ? ["Name", "Scope", "Window", "Reason", "Actions"] : ["Name", "Scope", "Window", "Reason"]} render={(silence) => [
        silence.name,
        silence.ruleId ? `Rule ${rules.find((rule) => rule.id === silence.ruleId)?.name ?? silence.ruleId}` : `Host ${hosts.find((host) => host.id === silence.hostId)?.name ?? silence.hostId ?? "all"}`,
        `${formatDate(silence.startsAt)} - ${formatDate(silence.endsAt)}`,
        silence.reason ?? "",
        ...(canManage ? [<button key="delete" className="danger" onClick={() => void confirmDelete("silence", silence.id, silence.name)}><Trash2 size={16} /></button>] : [])
      ]} />
      <div className="panelSectionTitle">History</div>
      <VirtualDataTable rows={events} maxRows={100} columns={["When", "State", "Message", "Delivery"]} render={(event) => [
        formatDate(event.createdAt),
        <StatusPill key="state" status={event.state} />,
        <div key="message" className="alertEventMessage">
          {event.message}
          {event.error && <small className="errorText">{event.error}</small>}
        </div>,
        event.silenced ? <span key="delivery" className="pill muted">silenced</span> : event.notified ? <span key="delivery" className="pill ok">notified</span> : ""
      ]} />
    </Panel>
  );
}
