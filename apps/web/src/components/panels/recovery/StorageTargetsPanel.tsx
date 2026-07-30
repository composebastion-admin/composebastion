import { useState } from "react";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { BackupTarget } from "@composebastion/shared";
import { deleteJson, patchJson, postJson } from "../../../api.js";
import { useAsyncAction } from "../../../hooks/useAsyncAction.js";
import { formatDate, emptyToUndefined } from "../../../lib/format.js";
import { useConfirm } from "../../ConfirmProvider.js";
import { ButtonRow, DataTable, InlineForm, Panel } from "../../ui/primitives.js";

export type TargetForm = {
  name: string;
  type: "local" | "s3" | "rclone";
  enabled: boolean;
  localCachePolicy: "keep" | "remote_only";
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  clearS3Credentials: boolean;
  provider: "smb" | "drive" | "onedrive" | "iclouddrive" | "webdav" | "sftp" | "custom";
  remoteName: string;
  remotePath: string;
  rcloneConfig: string;
  server: string;
  share: string;
  subPath: string;
  domain: string;
  username: string;
  password: string;
  clearPassword: boolean;
  port: string;
};

export const rcloneProviderOptions: Array<{ value: TargetForm["provider"]; label: string; experimental: boolean }> = [
  { value: "smb", label: "SMB / CIFS", experimental: false },
  { value: "drive", label: "Google Drive (experimental)", experimental: true },
  { value: "onedrive", label: "OneDrive (experimental)", experimental: true },
  { value: "iclouddrive", label: "iCloud Drive (experimental)", experimental: true },
  { value: "webdav", label: "WebDAV (experimental)", experimental: true },
  { value: "sftp", label: "SFTP (experimental)", experimental: true },
  { value: "custom", label: "Custom rclone config (experimental)", experimental: true }
];

const emptyForm = (): TargetForm => ({
  name: "",
  type: "local",
  enabled: true,
  localCachePolicy: "keep",
  endpoint: "",
  bucket: "",
  region: "",
  prefix: "",
  forcePathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
  clearS3Credentials: false,
  provider: "smb",
  remoteName: "",
  remotePath: "",
  rcloneConfig: "",
  server: "",
  share: "",
  subPath: "",
  domain: "",
  username: "",
  password: "",
  clearPassword: false,
  port: ""
});

export function formFromTarget(target: BackupTarget): TargetForm {
  const smb = target.config.smb && typeof target.config.smb === "object" && !Array.isArray(target.config.smb)
    ? target.config.smb as Record<string, unknown>
    : {};
  const smbText = (key: string) => typeof smb[key] === "string" ? smb[key] as string : "";
  return {
    name: target.name,
    type: target.type,
    enabled: target.enabled,
    localCachePolicy: target.type === "local" ? "keep" : target.localCachePolicy,
    endpoint: target.endpoint ?? "",
    bucket: target.bucket ?? "",
    region: target.region ?? "",
    prefix: target.prefix ?? "",
    forcePathStyle: target.forcePathStyle,
    accessKeyId: target.accessKeyId ?? "",
    secretAccessKey: "",
    clearS3Credentials: false,
    provider: target.rcloneProvider ?? "smb",
    remoteName: target.remoteName ?? "composebastion",
    remotePath: target.remotePath ?? "",
    rcloneConfig: "",
    server: smbText("server"),
    share: smbText("share"),
    subPath: smbText("subPath"),
    domain: smbText("domain"),
    username: smbText("username"),
    password: "",
    clearPassword: false,
    port: typeof smb.port === "number" || typeof smb.port === "string" ? String(smb.port) : ""
  };
}

export function formWithRcloneProvider(
  form: TargetForm,
  provider: TargetForm["provider"]
): TargetForm {
  if (provider === form.provider) return form;
  return {
    ...form,
    provider,
    remoteName: "",
    remotePath: "",
    rcloneConfig: "",
    server: "",
    share: "",
    subPath: "",
    domain: "",
    username: "",
    password: "",
    clearPassword: false,
    port: ""
  };
}

function optionalPatchText(value: string, editing: BackupTarget | null) {
  return emptyToUndefined(value) ?? (editing ? null : undefined);
}

export function buildBackupTargetPayload(form: TargetForm, editing: BackupTarget | null) {
  if (form.type === "local") {
    return {
      name: form.name,
      type: "local",
      enabled: form.enabled
    };
  }
  if (form.type === "rclone") {
    const payload: Record<string, unknown> = {
      name: form.name,
      type: "rclone",
      enabled: form.enabled,
      localCachePolicy: form.localCachePolicy,
      provider: form.provider,
      remoteName: emptyToUndefined(form.remoteName)
    };
    if (form.provider === "smb") {
      payload.server = form.server;
      payload.share = form.share;
      payload.subPath = optionalPatchText(form.subPath, editing);
      payload.domain = optionalPatchText(form.domain, editing);
      payload.username = optionalPatchText(form.username, editing);
      payload.port = form.port.trim() ? Number(form.port) : editing ? null : undefined;
      if (form.clearPassword) payload.password = null;
      else if (form.password.trim()) payload.password = form.password;
    } else if (form.rcloneConfig.trim()) {
      payload.rcloneConfig = form.rcloneConfig;
      payload.remotePath = emptyToUndefined(form.remotePath);
    } else {
      payload.remotePath = emptyToUndefined(form.remotePath);
    }
    return payload;
  }
  const payload: Record<string, unknown> = {
    name: form.name,
    type: "s3",
    enabled: form.enabled,
    localCachePolicy: form.localCachePolicy,
    endpoint: form.endpoint,
    bucket: form.bucket,
    region: optionalPatchText(form.region, editing),
    prefix: optionalPatchText(form.prefix, editing),
    forcePathStyle: form.forcePathStyle,
    accessKeyId: form.clearS3Credentials ? null : emptyToUndefined(form.accessKeyId)
  };
  if (form.clearS3Credentials) {
    payload.enabled = false;
    payload.secretAccessKey = null;
  } else if (form.secretAccessKey.trim()) payload.secretAccessKey = form.secretAccessKey;
  else if (editing?.hasSecretAccessKey) payload.secretAccessKey = undefined;
  return payload;
}

export function StorageTargetsPanel({
  targets,
  refresh
}: {
  targets: BackupTarget[];
  refresh: () => Promise<void>;
}) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [form, setForm] = useState<TargetForm>(emptyForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = targets.find((target) => target.id === editingId) ?? null;
  const testTarget = async (target: BackupTarget) => {
    await action.run(async () => {
      await postJson(`/api/recovery/targets/${target.id}/test`, {});
      await refresh();
    });
  };
  const deleteTarget = async (target: BackupTarget) => {
    const confirmed = await confirm({
      title: "Delete backup target",
      tone: "danger",
      confirmLabel: "Delete target",
      message: `Delete ${target.name}? Existing backup records will be preserved, but remote artifacts may no longer be reachable through this target.`
    });
    if (!confirmed) return;
    await action.run(async () => {
      await deleteJson(`/api/recovery/targets/${target.id}`);
      if (editingId === target.id) {
        setEditingId(null);
        setForm(emptyForm());
      }
      await refresh();
    });
  };

  return (
    <Panel title="Backup Storage" count={targets.length}>
      <InlineForm
        onSubmit={async () => {
          await action.run(async () => {
            const payload = buildBackupTargetPayload(form, editing);
            if (editing) {
              await patchJson(`/api/recovery/targets/${editing.id}`, payload);
            } else {
              if (form.type === "s3" && !form.secretAccessKey.trim()) {
                throw new Error("Secret access key is required for new S3 targets");
              }
              await postJson("/api/recovery/targets", payload);
            }
            setForm(emptyForm());
            setEditingId(null);
            await refresh();
          });
        }}
      >
        <strong>{editing ? "Edit storage" : "Add storage"}</strong>
        <input placeholder="Name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
        <select value={form.type} onChange={(event) => setForm((current) => ({ ...current, type: event.target.value as TargetForm["type"] }))} disabled={Boolean(editing)}>
          <option value="local">Local</option>
          <option value="s3">S3-compatible</option>
          <option value="rclone">SMB / Cloud (rclone)</option>
        </select>
        <label className="checkLine">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
          Enabled
        </label>
        {form.type !== "local" && (
          <select value={form.localCachePolicy} onChange={(event) => setForm((current) => ({ ...current, localCachePolicy: event.target.value as TargetForm["localCachePolicy"] }))}>
            <option value="keep">Keep local cache</option>
            <option value="remote_only">Remote only after verified upload</option>
          </select>
        )}
        {form.type === "s3" ? (
          <>
            <input placeholder="Endpoint URL" value={form.endpoint} onChange={(event) => setForm((current) => ({ ...current, endpoint: event.target.value }))} required />
            <input placeholder="Bucket" value={form.bucket} onChange={(event) => setForm((current) => ({ ...current, bucket: event.target.value }))} required />
            <input placeholder="Region" value={form.region} onChange={(event) => setForm((current) => ({ ...current, region: event.target.value }))} />
            <input placeholder="Prefix" value={form.prefix} onChange={(event) => setForm((current) => ({ ...current, prefix: event.target.value }))} />
            <input
              placeholder="Access key ID"
              value={form.accessKeyId}
              onChange={(event) => setForm((current) => ({
                ...current,
                accessKeyId: event.target.value,
                clearS3Credentials: false
              }))}
              required={!editing}
              disabled={form.clearS3Credentials}
            />
            <input
              type="password"
              placeholder={editing?.hasSecretAccessKey ? "Secret access key (leave blank to keep)" : "Secret access key"}
              value={form.secretAccessKey}
              onChange={(event) => setForm((current) => ({
                ...current,
                secretAccessKey: event.target.value,
                clearS3Credentials: false
              }))}
              required={!editing}
              disabled={form.clearS3Credentials}
            />
            {editing && (editing.accessKeyId || editing.hasSecretAccessKey) && (
              <label className="checkLine">
                <input
                  type="checkbox"
                  checked={form.clearS3Credentials}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    clearS3Credentials: event.target.checked,
                    enabled: event.target.checked ? false : current.enabled,
                    accessKeyId: event.target.checked ? "" : current.accessKeyId,
                    secretAccessKey: event.target.checked ? "" : current.secretAccessKey
                  }))}
                />
                Clear saved S3 credentials and disable target
              </label>
            )}
            <label className="checkLine">
              <input type="checkbox" checked={form.forcePathStyle} onChange={(event) => setForm((current) => ({ ...current, forcePathStyle: event.target.checked }))} />
              Force path-style URLs
            </label>
          </>
        ) : form.type === "rclone" ? (
          <>
            <select value={form.provider} onChange={(event) => setForm((current) => formWithRcloneProvider(current, event.target.value as TargetForm["provider"]))}>
              {rcloneProviderOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <input placeholder="Remote name" value={form.remoteName} onChange={(event) => setForm((current) => ({ ...current, remoteName: event.target.value }))} />
            {form.provider === "smb" ? (
              <>
                <input placeholder="Server or IP" value={form.server} onChange={(event) => setForm((current) => ({ ...current, server: event.target.value }))} required />
                <input placeholder="Share" value={form.share} onChange={(event) => setForm((current) => ({ ...current, share: event.target.value }))} required />
                <input placeholder="Subpath (optional)" value={form.subPath} onChange={(event) => setForm((current) => ({ ...current, subPath: event.target.value }))} />
                <input placeholder="Domain / workgroup" value={form.domain} onChange={(event) => setForm((current) => ({ ...current, domain: event.target.value }))} />
                <input placeholder="Username" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
                <input
                  type="password"
                  placeholder={editing?.hasGenericCredentials ? "Password (leave blank to keep)" : "Password"}
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value, clearPassword: false }))}
                  disabled={form.clearPassword}
                />
                {editing?.hasGenericCredentials && (
                  <label className="checkLine">
                    <input
                      type="checkbox"
                      checked={form.clearPassword}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        clearPassword: event.target.checked,
                        password: event.target.checked ? "" : current.password
                      }))}
                    />
                    Clear saved password
                  </label>
                )}
                <input placeholder="Port" inputMode="numeric" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} />
              </>
            ) : (
              <>
                <input placeholder="Remote path" value={form.remotePath} onChange={(event) => setForm((current) => ({ ...current, remotePath: event.target.value }))} />
                <textarea
                  placeholder={editing?.hasGenericConfig ? "Imported rclone config (leave blank to keep)" : "Paste rclone config for this remote"}
                  value={form.rcloneConfig}
                  onChange={(event) => setForm((current) => ({ ...current, rcloneConfig: event.target.value }))}
                  required={!editing || (editing.type === "rclone" && editing.rcloneProvider !== form.provider)}
                />
              </>
            )}
          </>
        ) : null}
        <ButtonRow>
          <button type="submit" className="primary" disabled={action.busy}>
            <Plus size={16} />
            {editing ? "Save storage" : "Add storage"}
          </button>
          {editing && (
            <button type="button" onClick={() => { setEditingId(null); setForm(emptyForm()); }}>
              Cancel
            </button>
          )}
        </ButtonRow>
      </InlineForm>

      {action.error && <div className="notice error" role="alert">{action.error}</div>}

      <DataTable
        rows={targets}
        columns={["Name", "Type", "Endpoint / path", "Bucket", "Cache", "Health", "Credentials", "Enabled", "Updated", ""]}
        render={(target) => [
          target.name,
          target.type === "rclone" ? `rclone:${target.rcloneProvider ?? "custom"}` : target.type,
          target.type === "s3" ? target.endpoint : target.type === "rclone" ? target.remotePath ?? "remote root" : "manager backup directory",
          target.bucket ?? "—",
          target.localCachePolicy === "remote_only" ? "remote only" : "keep",
          target.healthStatus === "healthy" ? "healthy" : target.healthStatus === "failed" ? (target.healthError ?? "failed") : "unknown",
          target.hasSecretAccessKey || target.hasGenericCredentials || target.hasGenericConfig ? "saved" : (target.accessKeyId ? "key only" : "—"),
          target.enabled ? "yes" : "no",
          formatDate(target.updatedAt),
          <ButtonRow key="actions">
            <button type="button" title="Test target" onClick={() => void testTarget(target).catch(() => undefined)} disabled={action.busy}>
              <ShieldCheck size={16} />
            </button>
            <button type="button" title="Edit target" onClick={() => { setEditingId(target.id); setForm(formFromTarget(target)); }}>
              <Pencil size={16} />
            </button>
            <button type="button" className="danger" title="Delete target" onClick={() => void deleteTarget(target).catch(() => undefined)} disabled={action.busy}>
              <Trash2 size={16} />
            </button>
          </ButtonRow>
        ]}
      />
    </Panel>
  );
}
