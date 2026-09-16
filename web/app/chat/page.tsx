"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Socket } from "socket.io-client";
import { clearSession, loadSession, Session } from "@/lib/auth";
import { fetchInbox, lookupUsername, resolveUserId, updateProfile } from "@/lib/api";
import {
  connectSignalSocket,
  InboundSignalMessage,
  sendReceipt,
  sendSignalMessage,
  sendViewed,
  SignalReceiptEvent,
  SignalViewedEvent,
} from "@/lib/socket";
import { SignalClient } from "@/lib/signal/signalClient";
import {
  appendMessage,
  Conversation,
  getConversations,
  getMessages,
  LocalMessage,
  markViewOnceOpened,
  updateMessageStatus,
  upsertConversation,
} from "@/lib/localDb";
import { MessageBubble } from "@/components/MessageBubble";
import { Avatar } from "@/components/Avatar";
import { EmojiPicker } from "@/components/EmojiPicker";
import { ProfileModal } from "@/components/ProfileModal";

export default function ChatPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>("Setting up encryption keys...");
  const [connected, setConnected] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activePeer, setActivePeer] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [newChatUsername, setNewChatUsername] = useState("");
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [viewOnceArmed, setViewOnceArmed] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  const clientRef = useRef<SignalClient | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activePeerRef = useRef<Conversation | null>(null);
  const initRan = useRef(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activePeerRef.current = activePeer;
  }, [activePeer]);

  const refreshConversations = useCallback(async (userId: string) => {
    setConversations(await getConversations(userId));
  }, []);

  // Resolves a username + avatar for a peer we may not have met before,
  // then upserts a conversation entry so it shows up in the sidebar.
  const ensureConversation = useCallback(
    async (userId: string, token: string, peerId: string, lastMessage: string, lastTimestamp: string) => {
      const known = conversations.find((c) => c.peerId === peerId);
      let peerUsername = known?.peerUsername;
      let peerAvatarUrl = known?.peerAvatarUrl;
      if (!peerUsername) {
        const resolved = await resolveUserId(token, peerId);
        peerUsername = resolved.username;
        peerAvatarUrl = resolved.avatarUrl;
      }
      const conv: Conversation = { peerId, peerUsername, peerAvatarUrl, lastMessage, lastTimestamp };
      await upsertConversation(userId, conv);
      await refreshConversations(userId);
      return conv;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [refreshConversations]
  );

  // Marks any unread incoming messages in `peerId`'s history as READ and
  // tells the sender, so their bubble turns into a blue double-tick.
  const markConversationRead = useCallback(
    async (userId: string, peerId: string, socket: Socket) => {
      const history = await getMessages(userId, peerId);
      const unread = history.filter((m) => m.direction === "in" && m.status !== "READ");
      for (const m of unread) {
        await sendReceipt(socket, m.id, "READ");
      }
    },
    []
  );

  useEffect(() => {
    const existing = loadSession();
    if (!existing) {
      router.replace("/login");
      return;
    }
    setSession(existing);
  }, [router]);

  useEffect(() => {
    if (!session || initRan.current) return;
    initRan.current = true;

    let cancelled = false;

    async function init() {
      if (!session) return;
      const client = new SignalClient(session.userId, session.token, process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000");
      clientRef.current = client;

      const hasIdentity = await client.hasLocalIdentity();
      if (!hasIdentity) {
        setStatusMessage("Generating your Signal identity + prekeys...");
        await client.generateAndPublishBundle();
      }
      if (cancelled) return;
      setStatusMessage(null);

      const socket = connectSignalSocket(session.token);
      socketRef.current = socket;

      socket.on("connect", () => setConnected(true));
      socket.on("disconnect", () => setConnected(false));

      socket.on("signal:message", async (msg: InboundSignalMessage) => {
        try {
          const plaintext = await client.decryptMessage(msg.senderId, {
            ciphertext: msg.ciphertext,
            signalMessageType: msg.signalMessageType,
          });

          await ensureConversation(session.userId, session.token, msg.senderId, msg.viewOnce ? "📷 View once photo" : plaintext, msg.timestamp);

          await appendMessage(session.userId, msg.senderId, {
            id: msg.id,
            direction: "in",
            body: plaintext,
            timestamp: msg.timestamp,
            status: "DELIVERED",
            viewOnce: msg.viewOnce,
          });

          if (activePeerRef.current?.peerId === msg.senderId) {
            setMessages(await getMessages(session.userId, msg.senderId));
          }
        } catch (err) {
          console.error(`Failed to process incoming message ${msg.id}:`, err);
        }
        await sendReceipt(socket, msg.id, "DELIVERED");
      });

      socket.on("signal:receipt", async (evt: SignalReceiptEvent) => {
        try {
          await updateMessageStatus(session.userId, evt.from, evt.messageId, evt.status);
          if (activePeerRef.current?.peerId === evt.from) {
            setMessages(await getMessages(session.userId, evt.from));
          }
        } catch (err) {
          console.error(`Failed to process receipt for ${evt.messageId}:`, err);
        }
      });

      // Sender-side notification that a view-once message we sent has been
      // opened by the recipient — flips its bubble to an "Opened" label.
      socket.on("signal:viewed", async (evt: SignalViewedEvent) => {
        try {
          await markViewOnceOpened(session.userId, evt.from, evt.messageId);
          if (activePeerRef.current?.peerId === evt.from) {
            setMessages(await getMessages(session.userId, evt.from));
          }
        } catch (err) {
          console.error(`Failed to process view notice for ${evt.messageId}:`, err);
        }
      });

      // Catch up on anything sent while we were offline. Each message is
      // handled independently — one bad/undecryptable message (e.g. a key
      // already consumed by an earlier interrupted attempt) must not take
      // down the rest of the catch-up batch or block startup.
      const pending = await fetchInbox(session.token);
      for (const msg of pending) {
        try {
          const plaintext = await client.decryptMessage(msg.senderId, {
            ciphertext: msg.ciphertext,
            signalMessageType: msg.signalMessageType,
          });
          await ensureConversation(session.userId, session.token, msg.senderId, msg.viewOnce ? "📷 View once photo" : plaintext, msg.timestamp);
          await appendMessage(session.userId, msg.senderId, {
            id: msg.id,
            direction: "in",
            body: plaintext,
            timestamp: msg.timestamp,
            status: "DELIVERED",
            viewOnce: msg.viewOnce,
          });
        } catch (err) {
          console.error(`Failed to process inbox message ${msg.id}, skipping:`, err);
        }
        // Ack regardless of decrypt success so an undecryptable message
        // doesn't keep re-appearing in the inbox on every future login.
        await sendReceipt(socket, msg.id, "DELIVERED");
      }

      await refreshConversations(session.userId);
    }

    init().catch((err) => {
      console.error(err);
      setStatusMessage(err instanceof Error ? err.message : "Failed to initialize.");
    });

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight });
  }, [messages]);

  async function handleSelectConversation(conv: Conversation) {
    if (!session) return;
    setActivePeer(conv);
    setShowEmojiPicker(false);
    setMessages(await getMessages(session.userId, conv.peerId));
    if (socketRef.current) {
      await markConversationRead(session.userId, conv.peerId, socketRef.current);
      setMessages(await getMessages(session.userId, conv.peerId));
    }
  }

  async function handleStartChat(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    setNewChatError(null);

    const username = newChatUsername.trim();
    if (!username) return;
    if (username === session.username) {
      setNewChatError("That's you.");
      return;
    }

    try {
      const found = await lookupUsername(session.token, username);
      const existing = conversations.find((c) => c.peerId === found.userId);
      const conv: Conversation = existing ?? {
        peerId: found.userId,
        peerUsername: found.username,
        peerAvatarUrl: found.avatarUrl,
        lastMessage: "",
        lastTimestamp: new Date().toISOString(),
      };
      await upsertConversation(session.userId, conv);
      await refreshConversations(session.userId);
      await handleSelectConversation(conv);
      setNewChatUsername("");
    } catch (err) {
      setNewChatError(err instanceof Error ? err.message : "User not found.");
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !session || !activePeer || !clientRef.current || !socketRef.current) return;

    setSending(true);
    const wasViewOnce = viewOnceArmed;
    try {
      const envelope = await clientRef.current.encryptMessage(activePeer.peerId, text);
      const ack = await sendSignalMessage(
        socketRef.current,
        activePeer.peerId,
        envelope.ciphertext,
        envelope.signalMessageType,
        wasViewOnce
      );

      if (!ack.ok || !ack.messageId) {
        throw new Error(ack.error ?? "Failed to send message.");
      }

      const timestamp = new Date().toISOString();
      await appendMessage(session.userId, activePeer.peerId, {
        id: ack.messageId,
        direction: "out",
        body: text,
        timestamp,
        status: "SENT",
        viewOnce: wasViewOnce,
      });
      const preview = wasViewOnce ? "📷 View once photo" : text;
      await upsertConversation(session.userId, { ...activePeer, lastMessage: preview, lastTimestamp: timestamp });
      await refreshConversations(session.userId);
      setMessages(await getMessages(session.userId, activePeer.peerId));
      setDraft("");
      setViewOnceArmed(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  async function handleOpenViewOnce(messageId: string) {
    if (!session || !activePeer || !socketRef.current) return;
    await markViewOnceOpened(session.userId, activePeer.peerId, messageId);
    await sendViewed(socketRef.current, messageId);
  }

  async function handleSaveProfile(patch: { avatarUrl?: string | null; statusText?: string | null }) {
    if (!session) return;
    const updated = await updateProfile(session.token, patch);
    const nextSession: Session = { ...session, avatarUrl: updated.avatarUrl, statusText: updated.statusText };
    setSession(nextSession);
    localStorage.setItem("matrix-chat-session", JSON.stringify(nextSession));
  }

  function handleLogout() {
    socketRef.current?.disconnect();
    clearSession();
    router.replace("/login");
  }

  function handleSelectEmoji(emoji: string) {
    setDraft((d) => d + emoji);
    setShowEmojiPicker(false);
  }

  if (!session) {
    return <div className="loading-screen">Redirecting to login...</div>;
  }

  if (statusMessage) {
    return <div className="loading-screen">{statusMessage}</div>;
  }

  return (
    <div className="chat-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <button className="me" onClick={() => setShowProfileModal(true)}>
            <Avatar name={session.username} avatarUrl={session.avatarUrl} size={36} />
            <span className="me-text">
              <span className="me-name">
                <span className={`conn-dot ${connected ? "online" : ""}`} />
                {session.username}
              </span>
              <span className="me-status">{session.statusText}</span>
            </span>
          </button>
          <button className="logout-btn" onClick={handleLogout}>
            Log out
          </button>
        </div>

        <form className="new-chat-row" onSubmit={handleStartChat}>
          <input
            placeholder="Start chat with username..."
            value={newChatUsername}
            onChange={(e) => setNewChatUsername(e.target.value)}
          />
          <button type="submit">Go</button>
        </form>
        {newChatError && <div className="inline-error">{newChatError}</div>}

        <div className="conversation-list">
          {conversations.length === 0 && (
            <div className="empty-conversations">No conversations yet. Start one above.</div>
          )}
          {conversations.map((conv) => (
            <div
              key={conv.peerId}
              className={`conversation-item ${activePeer?.peerId === conv.peerId ? "active" : ""}`}
              onClick={() => handleSelectConversation(conv)}
            >
              <Avatar name={conv.peerUsername} avatarUrl={conv.peerAvatarUrl} size={44} />
              <span className="conversation-text">
                <span className="peer">{conv.peerUsername}</span>
                <span className="preview">{conv.lastMessage || "No messages yet"}</span>
              </span>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        {!activePeer ? (
          <div className="chat-empty-state">Select a conversation or start a new one to begin an encrypted chat.</div>
        ) : (
          <>
            <div className="chat-header">
              <Avatar name={activePeer.peerUsername} avatarUrl={activePeer.peerAvatarUrl} size={38} />
              <span className="chat-header-text">
                <span className="chat-header-name">{activePeer.peerUsername}</span>
                <span className="lock">🔒 End-to-end encrypted</span>
              </span>
            </div>
            <div className="message-list" ref={messageListRef}>
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} onOpenViewOnce={handleOpenViewOnce} />
              ))}
            </div>
            <form className="composer" onSubmit={handleSend}>
              <div className="composer-input-pill">
                <button
                  type="button"
                  className="composer-emoji-btn"
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  aria-label="Emoji"
                >
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <circle cx="12" cy="12" r="9.25" />
                    <circle cx="8.7" cy="10" r="1.05" fill="currentColor" stroke="none" />
                    <circle cx="15.3" cy="10" r="1.05" fill="currentColor" stroke="none" />
                    <path d="M7.5 14.25c1.05 1.5 2.7 2.35 4.5 2.35s3.45-.85 4.5-2.35" strokeLinecap="round" />
                  </svg>
                </button>
                {showEmojiPicker && (
                  <EmojiPicker onSelect={handleSelectEmoji} onClose={() => setShowEmojiPicker(false)} />
                )}
                <input
                  placeholder={viewOnceArmed ? "View-once message..." : "Type a message"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={sending}
                />
              </div>
              <button
                type="button"
                className={`composer-icon-btn ${viewOnceArmed ? "armed" : ""}`}
                onClick={() => setViewOnceArmed((v) => !v)}
                aria-label="Toggle view-once"
                title="Send as view-once"
              >
                {viewOnceArmed ? "1️⃣" : "👁"}
              </button>
              <button type="submit" className="composer-send-btn" disabled={sending || !draft.trim()}>
                ➤
              </button>
            </form>
          </>
        )}
      </main>

      {showProfileModal && (
        <ProfileModal
          username={session.username}
          avatarUrl={session.avatarUrl}
          statusText={session.statusText}
          onSave={handleSaveProfile}
          onClose={() => setShowProfileModal(false)}
        />
      )}
    </div>
  );
}
