import { useState } from "react";

interface AddToListModalProps {
  lists: string[];
  selected: string[];
  onToggle: (listName: string) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}

export function AddToListModal({ lists, selected, onToggle, onCreate, onClose }: AddToListModalProps) {
  const [newListName, setNewListName] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newListName.trim();
    if (!name) return;
    onCreate(name);
    setNewListName("");
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">
        <h2 className="modal-title">Add to list</h2>
        {lists.length === 0 ? (
          <p className="modal-subtitle">You don't have any lists yet -- create one below.</p>
        ) : (
          <div className="option-list">
            {lists.map((name) => (
              <button key={name} className="option-list-item" onClick={() => onToggle(name)}>
                {name}
                {selected.includes(name) && <span className="option-list-check">✓</span>}
              </button>
            ))}
          </div>
        )}
        <form className="new-group-add-row" onSubmit={handleCreate}>
          <input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="New list name"
            maxLength={40}
          />
          <button className="btn-secondary" type="submit">
            Create
          </button>
        </form>
        <div className="modal-actions">
          <button className="btn-primary" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
