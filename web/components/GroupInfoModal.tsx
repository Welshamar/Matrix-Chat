import { useState } from "react";
import { lookupUsername } from "@/lib/api";
import { LocalGroup } from "@/lib/localDb";
import { Avatar } from "./Avatar";

interface GroupInfoModalProps {
  group: LocalGroup;
  myUserId: string;
  token: string;
  onAddMember: (userId: string) => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  onSetRole: (userId: string, role: "ADMIN" | "MEMBER") => Promise<void>;
  onLeave: () => Promise<void>;
  onClose: () => void;
}

export function GroupInfoModal({
  group,
  myUserId,
  token,
  onAddMember,
  onRemoveMember,
  onSetRole,
  onLeave,
  onClose,
}: GroupInfoModalProps) {
  const [usernameInput, setUsernameInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const me = group.members.find((m) => m.userId === myUserId);
  const isAdmin = me?.role === "ADMIN";

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const username = usernameInput.trim();
    if (!username) return;
    setBusy(true);
    setError(null);
    try {
      const found = await lookupUsername(token, username);
      await onAddMember(found.userId);
      setUsernameInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">
        <h2 className="modal-title">{group.name}</h2>
        <p className="group-info-subtitle">{group.members.length} members</p>

        {isAdmin && (
          <form className="new-group-add-row" onSubmit={handleAdd} style={{ marginBottom: 16 }}>
            <input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder="Add member by username"
              disabled={busy}
            />
            <button className="btn-secondary" type="submit" disabled={busy}>
              Add
            </button>
          </form>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div className="group-member-list">
          {group.members.map((m) => (
            <div key={m.userId} className="group-member-row">
              <Avatar name={m.username} avatarUrl={m.avatarUrl} size={36} />
              <span className="group-member-name">
                {m.username}
                {m.userId === myUserId && " (you)"}
                <span className="group-member-role">{m.role === "ADMIN" ? "Admin" : ""}</span>
              </span>
              {isAdmin && m.userId !== myUserId && (
                <div className="group-member-actions">
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => onSetRole(m.userId, m.role === "ADMIN" ? "MEMBER" : "ADMIN")}
                  >
                    {m.role === "ADMIN" ? "Demote" : "Make admin"}
                  </button>
                  <button className="btn-secondary" type="button" onClick={() => onRemoveMember(m.userId)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onLeave}>
            Leave group
          </button>
          <button className="btn-primary" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
