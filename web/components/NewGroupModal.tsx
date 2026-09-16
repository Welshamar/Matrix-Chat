import { useState } from "react";
import { lookupUsername } from "@/lib/api";
import { Avatar } from "./Avatar";

interface PickedMember {
  userId: string;
  username: string;
  avatarUrl: string | null;
}

interface NewGroupModalProps {
  token: string;
  myUsername: string;
  onCreate: (name: string, memberUserIds: string[]) => Promise<void>;
  onClose: () => void;
}

export function NewGroupModal({ token, myUsername, onCreate, onClose }: NewGroupModalProps) {
  const [name, setName] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [members, setMembers] = useState<PickedMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    const username = usernameInput.trim();
    if (!username) return;
    if (username === myUsername) {
      setError("That's you — you're already in the group.");
      return;
    }
    if (members.some((m) => m.username.toLowerCase() === username.toLowerCase())) {
      setError("Already added.");
      return;
    }
    try {
      setError(null);
      const found = await lookupUsername(token, username);
      setMembers((m) => [...m, { userId: found.userId, username: found.username, avatarUrl: found.avatarUrl }]);
      setUsernameInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "User not found.");
    }
  }

  function handleRemoveMember(userId: string) {
    setMembers((m) => m.filter((x) => x.userId !== userId));
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError("Give the group a name.");
      return;
    }
    if (members.length === 0) {
      setError("Add at least one other member.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onCreate(name.trim(), members.map((m) => m.userId));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">
        <h2 className="modal-title">New group</h2>

        <div className="field">
          <label>Group name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Weekend Trip" />
        </div>

        <form className="field" onSubmit={handleAddMember}>
          <label>Add members (must already have a Matrix Chat account)</label>
          <div className="new-group-add-row">
            <input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder="username"
            />
            <button className="btn-secondary" type="submit">
              Add
            </button>
          </div>
        </form>

        {members.length > 0 && (
          <div className="new-group-members">
            {members.map((m) => (
              <div key={m.userId} className="new-group-member-chip">
                <Avatar name={m.username} avatarUrl={m.avatarUrl} size={24} />
                <span>{m.username}</span>
                <button type="button" onClick={() => handleRemoveMember(m.userId)} aria-label={`Remove ${m.username}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button className="btn-primary" type="button" onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Create group"}
          </button>
        </div>
      </div>
    </>
  );
}
