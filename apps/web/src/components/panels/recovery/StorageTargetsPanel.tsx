import { useState } from "react";
import { Pencil, Plus, ShieldCheck } from "lucide-react";
import type { BackupTarget } from "@dockermender/shared";
import { patchJson, postJson } from "../../../api.js";
import { useAsyncAction } from "../../../hooks/useAsyncAction.js";
import { formatDate, emptyToUndefined } from "../../../lib/format.js";
import { ButtonRow, DataTable, InlineForm, Panel } from "../../ui/primitives.js";

type TargetForm = {
  name: string;
  type: "local" | "s3" | "rclone";
  enabled: boolean;
  localCachePolicy: "keep" | "remote_only";
  basePath: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
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
  port: string;
};

const emptyForm = (): TargetForm => ({
  name: "",
  type: "local",
  enabled: true,
  localCachePolicy: "keep",
  basePath: "",
  endpoint: "",
  bucket: "",
  region: "",
  prefix: "",
  forcePathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
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
  port: ""
});

function formFromTarget(target: BackupTarget): TargetForm {
  return {
    name: target.name,
    type: target.type,
    enabled: target.enabled,
    localCachePolicy: target.localCachePolicy,
    basePath: target.basePath ?? "",
    endpoint: target.endpoint ?? "",
    bucket: target.bucket ?? "",
    region: target.region ?? "",
    prefix: target.prefix ?? "",
    forcePathStyle: target.forcePathStyle,
    accessKeyId: target.accessKeyId ?? "",
    secretAccessKey: "",
    provider: target.rcloneProvider ?? "smb",
    remoteName: target.remoteName ?? "dockermender",
    remotePath: target.remotePath ?? "",
    rcloneConfig: "",
    server: "",
    share: "",
    subPath: "",
    domain: "",
    username: "",
    password: "",
    port: ""
  };
}

function buildPayload(form: TargetForm, editing: BackupTarget | null) {
  if (form.type === "local") {
    return {
      name: form.name,
      type: "local",
      enabled: form.enabled,
      localCachePolicy: form.localCachePolicy,
      basePath: emptyToUndefined(form.basePath)
    };
  }
  if (form.type === "rclone") {
    const payload: Record<string, unknown> = {
      name: form.name,
      type: "rclone",
      enabled: form.enabled,
      localCachePolicy: form.localCachePolicy,
      provider: form.provider,
      remoteName: emptyToUndefined(form.remoteName),
      remotePath: emptyToUndefined(form.remotePath)
    };
    if (form.provider === "smb") {
      payload.server = form.server;
      payload.share = form.share;
      payload.subPath = emptyToUndefined(form.subPath);
      payload.domain = emptyToUndefined(form.domain);
      payload.username = emptyToUndefined(form.username);
      payload.port = form.port.trim() ? Number(form.port) : undefined;
      if (form.password.trim()) payload.password = form.password;
    } else if (form.rcloneConfig.trim()) {
      payload.rcloneConfig = form.rcloneConfig;
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
    region: emptyToUndefined(form.region),
    prefix: emptyToUndefined(form.prefix),
    forcePathStyle: form.forcePathStyle,
    accessKeyId: emptyToUndefined(form.accessKeyId)
  };
  if (form.secretAccessKey.trim()) payload.secretAccessKey = form.secretAccessKey;
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

  return (
    <Panel title="Backup Storage" count={targets.length}>
      <InlineForm
        onSubmit={async () => {
          await action.run(async () => {
            const payload = buildPayload(form, editing);
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
        <select value={form.localCachePolicy} onChange={(event) => setForm((current) => ({ ...current, localCachePolicy: event.target.value as TargetForm["localCachePolicy"] }))}>
          <option value="keep">Keep local cache</option>
          <option value="remote_only">Remote only after upload</option>
        </select>
        {form.type === "local" ? (
          <input placeholder="Base path (optional)" value={form.basePath} onChange={(event) => setForm((current) => ({ ...current, basePath: event.target.value }))} />
        ) : form.type === "s3" ? (
          <>
            <input placeholder="Endpoint URL" value={form.endpoint} onChange={(event) => setForm((current) => ({ ...current, endpoint: event.target.value }))} required />
            <input placeholder="Bucket" value={form.bucket} onChange={(event) => setForm((current) => ({ ...current, bucket: event.target.value }))} required />
            <input placeholder="Region" value={form.region} onChange={(event) => setForm((current) => ({ ...current, region: event.target.value }))} />
            <input placeholder="Prefix" value={form.prefix} onChange={(event) => setForm((current) => ({ ...current, prefix: event.target.value }))} />
            <input placeholder="Access key ID" value={form.accessKeyId} onChange={(event) => setForm((current) => ({ ...current, accessKeyId: event.target.value }))} required={!editing} />
            <input
              type="password"
              placeholder={editing?.hasSecretAccessKey ? "Secret access key (leave blank to keep)" : "Secret access key"}
              value={form.secretAccessKey}
              onChange={(event) => setForm((current) => ({ ...current, secretAccessKey: event.target.value }))}
              required={!editing}
            />
            <label className="checkLine">
              <input type="checkbox" checked={form.forcePathStyle} onChange={(event) => setForm((current) => ({ ...current, forcePathStyle: event.target.checked }))} />
              Force path-style URLs
            </label>
          </>
        ) : (
          <>
            <select value={form.provider} onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value as TargetForm["provider"] }))}>
              <option value="smb">SMB / CIFS</option>
              <option value="drive">Google Drive (beta)</option>
              <option value="onedrive">OneDrive (beta)</option>
              <option value="iclouddrive">iCloud Drive (beta)</option>
              <option value="webdav">WebDAV (beta)</option>
              <option value="sftp">SFTP (beta)</option>
              <option value="custom">Custom rclone config</option>
            </select>
            <input placeholder="Remote name" value={form.remoteName} onChange={(event) => setForm((current) => ({ ...current, remoteName: event.target.value }))} />
            {form.provider === "smb" ? (
              <>
                <input placeholder="Server or IP" value={form.server} onChange={(event) => setForm((current) => ({ ...current, server: event.target.value }))} required />
                <input placeholder="Share" value={form.share} onChange={(event) => setForm((current) => ({ ...current, share: event.target.value }))} required />
                <input placeholder="Subpath (optional)" value={form.subPath} onChange={(event) => setForm((current) => ({ ...current, subPath: event.target.value }))} />
                <input placeholder="Domain / workgroup" value={form.domain} onChange={(event) => setForm((current) => ({ ...current, domain: event.target.value }))} />
                <input placeholder="Username" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
                <input type="password" placeholder={editing?.hasGenericCredentials ? "Password (leave blank to keep)" : "Password"} value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
                <input placeholder="Port" inputMode="numeric" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} />
              </>
            ) : (
              <>
                <input placeholder="Remote path" value={form.remotePath} onChange={(event) => setForm((current) => ({ ...current, remotePath: event.target.value }))} />
                <textarea placeholder={editing?.hasGenericConfig ? "Imported rclone config (leave blank to keep)" : "Paste rclone config for this remote"} value={form.rcloneConfig} onChange={(event) => setForm((current) => ({ ...current, rcloneConfig: event.target.value }))} required={!editing} />
              </>
            )}
          </>
        )}
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

      {action.error && <div className="notice error">{action.error}</div>}

      <DataTable
        rows={targets}
        columns={["Name", "Type", "Endpoint / path", "Bucket", "Cache", "Health", "Credentials", "Enabled", "Updated", ""]}
        render={(target) => [
          target.name,
          target.type === "rclone" ? `rclone:${target.rcloneProvider ?? "custom"}` : target.type,
          target.type === "s3" ? target.endpoint : target.type === "rclone" ? target.remotePath ?? "remote root" : (target.basePath ?? "default"),
          target.bucket ?? "—",
          target.localCachePolicy === "remote_only" ? "remote only" : "keep",
          target.healthStatus === "healthy" ? "healthy" : target.healthStatus === "failed" ? (target.healthError ?? "failed") : "unknown",
          target.hasSecretAccessKey || target.hasGenericCredentials || target.hasGenericConfig ? "saved" : (target.accessKeyId ? "key only" : "—"),
          target.enabled ? "yes" : "no",
          formatDate(target.updatedAt),
          <ButtonRow key="actions">
            <button type="button" title="Test target" onClick={() => void testTarget(target)} disabled={action.busy}>
              <ShieldCheck size={16} />
            </button>
            <button type="button" title="Edit target" onClick={() => { setEditingId(target.id); setForm(formFromTarget(target)); }}>
              <Pencil size={16} />
            </button>
          </ButtonRow>
        ]}
      />
    </Panel>
  );
}
