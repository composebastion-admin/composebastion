import { useCallback, useEffect, useState } from "react";
import { Trash2, Users } from "lucide-react";
import type { AdminUser } from "@composebastion/shared";
import { api, deleteJson, postJson, putJson } from "../../api.js";
import { emptyToUndefined } from "../../lib/format.js";
import { ButtonRow, DataTable, Panel } from "../ui/primitives.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";

export function UsersPanel({ currentUser }: { currentUser: AdminUser }) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [form, setForm] = useState({ name: "", username: "", email: "", password: "", role: "operator" });
  const load = useCallback(async () => {
    const result = await api<{ users: AdminUser[] }>("/api/users");
    setUsers(result.users);
  }, []);

  useEffect(() => {
    void action.run(load).catch(() => undefined);
  }, [action.run, load]);

  async function createUser() {
    await action.run(async () => {
      await postJson("/api/users", { ...form, username: emptyToUndefined(form.username) });
      setForm({ name: "", username: "", email: "", password: "", role: "operator" });
      await load();
    });
  }

  async function updateUser(user: AdminUser, patch: { role?: AdminUser["role"]; isActive?: boolean }) {
    if (patch.isActive === false && !await confirm({
      title: "Disable user",
      tone: "danger",
      confirmLabel: "Disable",
      message: `Disable ${user.email} and revoke their active sessions?`
    })) return;
    await action.run(async () => {
      await putJson(`/api/users/${user.id}`, patch);
      await load();
    });
  }

  async function removeUser(user: AdminUser) {
    if (!await confirm({
      title: "Delete user",
      tone: "danger",
      confirmLabel: "Delete",
      message: `Permanently delete ${user.email}?`
    })) return;
    await action.run(async () => {
      await deleteJson(`/api/users/${user.id}`);
      await load();
    });
  }

  return (
    <Panel title="Team Users" count={users.length}>
      <form className="inlineForm" onSubmit={(event) => {
        event.preventDefault();
        void createUser().catch(() => undefined);
      }}>
        <input aria-label="User name" placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input aria-label="Username" placeholder="Username, optional" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
        <input aria-label="User email" placeholder="Email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
        <input aria-label="Temporary password" placeholder="Temporary password" type="password" minLength={12} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
        <select aria-label="New user role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
        </select>
        <button className="primary" disabled={action.busy}><Users size={18} />Add</button>
      </form>
      {action.error && <div className="notice error" role="alert">{action.error}</div>}
      <DataTable rows={users} columns={["Name", "Username", "Email", "Role", "Active", "Actions"]} render={(user) => [
        user.name ?? "",
        user.username ?? "",
        user.email,
        <select
          key="role"
          aria-label={`Role for ${user.email}`}
          value={user.role}
          disabled={action.busy || user.id === currentUser.id}
          onChange={(event) => void updateUser(user, { role: event.target.value as AdminUser["role"] }).catch(() => undefined)}
        >
          <option value="owner">owner</option>
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
        </select>,
        user.isActive ? "yes" : "no",
        <ButtonRow key="actions">
          <button
            disabled={action.busy || (user.id === currentUser.id && user.isActive)}
            title={user.id === currentUser.id && user.isActive ? "You cannot disable your own account" : undefined}
            onClick={() => void updateUser(user, { isActive: !user.isActive }).catch(() => undefined)}
          >{user.isActive ? "Disable" : "Enable"}</button>
          <button
            className="danger"
            disabled={action.busy || user.id === currentUser.id}
            title={user.id === currentUser.id ? "You cannot delete your own account" : undefined}
            aria-label={`Delete ${user.email}`}
            onClick={() => void removeUser(user).catch(() => undefined)}
          ><Trash2 size={16} /></button>
        </ButtonRow>
      ]} />
    </Panel>
  );
}
