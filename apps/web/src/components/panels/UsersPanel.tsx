import { useCallback, useEffect, useState } from "react";
import { Trash2, Users } from "lucide-react";
import type { AdminUser } from "@composebastion/shared";
import { api, deleteJson, postJson, putJson } from "../../api.js";
import { emptyToUndefined } from "../../lib/format.js";
import { ButtonRow, DataTable, Panel } from "../ui/primitives.js";
import { useConfirm } from "../ConfirmProvider.js";

export function UsersPanel({ currentUser }: { currentUser: AdminUser }) {
  const { confirm } = useConfirm();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [form, setForm] = useState({ name: "", username: "", email: "", password: "", role: "operator" });
  const load = useCallback(async () => {
    const result = await api<{ users: AdminUser[] }>("/api/users");
    setUsers(result.users);
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <Panel title="Team Users" count={users.length}>
      <form className="inlineForm" onSubmit={(event) => { event.preventDefault(); void postJson("/api/users", { ...form, username: emptyToUndefined(form.username) }).then(load); }}>
        <input placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input placeholder="Username, optional" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
        <input placeholder="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
        <input placeholder="Temporary password" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required />
        <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
        </select>
        <button className="primary"><Users size={18} />Add</button>
      </form>
      <DataTable rows={users} columns={["Name", "Username", "Email", "Role", "Active", "Actions"]} render={(user) => [
        user.name ?? "",
        user.username ?? "",
        user.email,
        user.role,
        user.isActive ? "yes" : "no",
        <ButtonRow key="actions">
          <button
            disabled={user.id === currentUser.id && user.isActive}
            title={user.id === currentUser.id && user.isActive ? "You cannot disable your own account" : undefined}
            onClick={() => void (async () => {
              if (user.isActive && !await confirm({ title: "Disable user", tone: "danger", confirmLabel: "Disable", message: `Disable ${user.email} and revoke their active sessions?` })) return;
              await putJson(`/api/users/${user.id}`, { isActive: !user.isActive });
              await load();
            })()}
          >{user.isActive ? "Disable" : "Enable"}</button>
          <button
            className="danger"
            disabled={user.id === currentUser.id}
            title={user.id === currentUser.id ? "You cannot delete your own account" : undefined}
            onClick={() => void (async () => {
              if (!await confirm({ title: "Delete user", tone: "danger", confirmLabel: "Delete", message: `Permanently delete ${user.email}?` })) return;
              await deleteJson(`/api/users/${user.id}`);
              await load();
            })()}
          ><Trash2 size={16} /></button>
        </ButtonRow>
      ]} />
    </Panel>
  );
}
