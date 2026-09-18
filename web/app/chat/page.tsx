"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Socket } from "socket.io-client";
import { clearSession, loadSession, Session } from "@/lib/auth";
import {
  addGroupMember,
  createGroup as createGroupApi,
  fetchInbox,
  getGroup,
  listGroups,
  lookupUsername,
  registerPushToken,
  removeGroupMember,
  resolveUserId,
  updateGroupMemberRole,
  updateProfile,
} from "@/lib/api";
import {
  CallAnsweredEvent,
  CallEndedEvent,
  CallIceEvent,
  connectSignalSocket,
  IncomingCallEvent,
  InboundSignalMessage,
  sendReceipt,
  sendSignalMessage,
  sendViewed,
  SignalReceiptEvent,
  SignalViewedEvent,
} from "@/lib/socket";
import { SignalClient } from "@/lib/signal/signalClient";
import { CallClient } from "@/lib/callClient";
import { RingtonePlayer } from "@/lib/ringtone";
import { startCallAudioRouting, stopCallAudioRouting } from "@/lib/callAudio";
import { playReceivedTone, playSentTone } from "@/lib/messageTone";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { registerForPushNotifications } from "@/lib/pushNotifications";
import {
  appendMessage,
  clearGroupUnread,
  clearUnread,
  Conversation,
  deleteMessage,
  getConversations,
  getGroups,
  getMessages,
  groupThreadKey,
  incrementGroupUnread,
  incrementUnread,
  LocalGroup,
  LocalMessage,
  markViewOnceOpened,
  toggleFavourite,
  toggleGroupFavourite,
  updateMessageStatus,
  upsertConversation,
  upsertGroup,
} from "@/lib/localDb";
import { encodeEnvelope, decodeEnvelope, FileMeta, ReplyRef } from "@/lib/messageEnvelope";
import { MessageBubble } from "@/components/MessageBubble";
import { Avatar } from "@/components/Avatar";
import { EmojiPicker } from "@/components/EmojiPicker";
import { ProfileModal } from "@/components/ProfileModal";
import { NewGroupModal } from "@/components/NewGroupModal";
import { GroupInfoModal } from "@/components/GroupInfoModal";
import { ContactDetailsPanel } from "@/components/ContactDetailsPanel";
import { CallOverlay, CallStatus } from "@/components/CallOverlay";
import { VoiceRecorderButton } from "@/components/VoiceRecorderButton";
import { FileAttachButton } from "@/components/FileAttachButton";

type ChatFilter = "all" | "unread" | "favourites" | "groups";

interface ThreadView {
  key: string;
  isGroup: boolean;
  name: string;
  avatarUrl?: string | null;
  lastMessage: string;
  lastTimestamp: string;
  favourite?: boolean;
  unreadCount?: number;
}

export default function ChatPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>("Setting up encryption keys...");
  const [connected, setConnected] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [activePeer, setActivePeer] = useState<Conversation | null>(null);
  const [activeGroup, setActiveGroup] = useState<LocalGroup | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [showMenu, setShowMenu] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [viewOnceArmed, setViewOnceArmed] = useState(false);
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showNewGroupModal, setShowNewGroupModal] = useState(false);
  const [showGroupInfoModal, setShowGroupInfoModal] = useState(false);
  const [showContactDetails, setShowContactDetails] = useState(false);
  const [replyingTo, setReplyingTo] = useState<LocalMessage | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus | null>(null);
  const [callPeer, setCallPeer] = useState<{ userId: string; username: string; avatarUrl?: string | null } | null>(
    null
  );
  const [callDuration, setCallDuration] = useState(0);
  const [callMuted, setCallMuted] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [callNeedsAudioUnlock, setCallNeedsAudioUnlock] = useState(false);

  const clientRef = useRef<SignalClient | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activePeerRef = useRef<Conversation | null>(null);
  const activeGroupRef = useRef<LocalGroup | null>(null);
  const groupsRef = useRef<LocalGroup[]>([]);
  const initRan = useRef(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const callClientRef = useRef<CallClient | null>(null);
  const callIdRef = useRef<string | null>(null);
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callRingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callRingtoneRef = useRef<RingtonePlayer | null>(null);
  // Which side of the call I was on originally — kept separately from
  // callStatus because that transitions to "connected" once answered, and
  // the call-log entry logged on teardown still needs to know.
  const callDirectionRef = useRef<"outgoing" | "incoming" | null>(null);
  // Mirrors of call state for the socket listeners registered once inside
  // the init() effect below — those close over whichever render was active
  // when they were registered, so they read refs instead of state directly.
  const callStatusRef = useRef<CallStatus | null>(null);
  const callDurationRef = useRef(0);
  const callPeerRef = useRef<{ userId: string; username: string; avatarUrl?: string | null } | null>(null);

  useEffect(() => {
    callStatusRef.current = callStatus;
  }, [callStatus]);
  useEffect(() => {
    callDurationRef.current = callDuration;
  }, [callDuration]);
  useEffect(() => {
    callPeerRef.current = callPeer;
  }, [callPeer]);

  useEffect(() => {
    activePeerRef.current = activePeer;
  }, [activePeer]);
  useEffect(() => {
    activeGroupRef.current = activeGroup;
  }, [activeGroup]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // --- Android hardware back button ---
  // Refs so the one-time listener registered below (see the Capacitor
  // effect further down) always reads current state without needing to
  // re-register on every state change, matching the pattern already used
  // for call state above.
  const showGroupInfoModalRef = useRef(false);
  const showNewGroupModalRef = useRef(false);
  const showProfileModalRef = useRef(false);
  const showContactDetailsRef = useRef(false);
  const showEmojiPickerRef = useRef(false);
  const exitPromptArmedRef = useRef(false);
  const exitPromptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showExitPrompt, setShowExitPrompt] = useState(false);

  useEffect(() => {
    showGroupInfoModalRef.current = showGroupInfoModal;
  }, [showGroupInfoModal]);
  useEffect(() => {
    showNewGroupModalRef.current = showNewGroupModal;
  }, [showNewGroupModal]);
  useEffect(() => {
    showProfileModalRef.current = showProfileModal;
  }, [showProfileModal]);
  useEffect(() => {
    showContactDetailsRef.current = showContactDetails;
  }, [showContactDetails]);
  useEffect(() => {
    showEmojiPickerRef.current = showEmojiPicker;
  }, [showEmojiPicker]);

  // Mirrors WhatsApp: back closes whatever's open (innermost first), then
  // backs out of an open thread to the chat list, and only exits the app
  // from the list root after a second back press within 2s. Only wired up
  // inside the Capacitor Android shell — a normal browser tab already gets
  // correct back behavior for free from browser history, and there's no
  // hardware back button to intercept on desktop/iOS anyway.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let removed = false;
    let handle: { remove: () => void } | null = null;

    const subPromise = CapacitorApp.addListener("backButton", () => {
      if (showGroupInfoModalRef.current) {
        setShowGroupInfoModal(false);
        return;
      }
      if (showNewGroupModalRef.current) {
        setShowNewGroupModal(false);
        return;
      }
      if (showProfileModalRef.current) {
        setShowProfileModal(false);
        return;
      }
      if (showContactDetailsRef.current) {
        setShowContactDetails(false);
        return;
      }
      if (showEmojiPickerRef.current) {
        setShowEmojiPicker(false);
        return;
      }
      // An active call overlay intentionally swallows back rather than
      // hanging up or exiting — accidentally dropping a call is worse than
      // a no-op here.
      if (callStatusRef.current) return;
      if (activePeerRef.current || activeGroupRef.current) {
        handleBackToList();
        return;
      }
      if (exitPromptArmedRef.current) {
        CapacitorApp.exitApp();
        return;
      }
      exitPromptArmedRef.current = true;
      setShowExitPrompt(true);
      if (exitPromptTimeoutRef.current) clearTimeout(exitPromptTimeoutRef.current);
      exitPromptTimeoutRef.current = setTimeout(() => {
        exitPromptArmedRef.current = false;
        setShowExitPrompt(false);
      }, 2000);
    });
    subPromise.then((h) => {
      if (removed) {
        h.remove();
        return;
      }
      handle = h;
    });

    return () => {
      removed = true;
      handle?.remove();
      if (exitPromptTimeoutRef.current) clearTimeout(exitPromptTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshConversations = useCallback(async (userId: string) => {
    setConversations(await getConversations(userId));
  }, []);

  const refreshGroups = useCallback(async (userId: string) => {
    setGroups(await getGroups(userId));
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

  // Fetches (and caches) a group's roster the first time we see a message
  // for it — happens when someone adds us, or on our very first login.
  const ensureGroup = useCallback(
    async (userId: string, token: string, groupId: string, lastMessage: string, lastTimestamp: string) => {
      let group = groupsRef.current.find((g) => g.groupId === groupId);
      if (!group) {
        const fetched = await getGroup(token, groupId);
        group = {
          groupId: fetched.groupId,
          name: fetched.name,
          avatarUrl: fetched.avatarUrl,
          members: fetched.members,
          lastMessage,
          lastTimestamp,
        };
      }
      await upsertGroup(userId, { ...group, lastMessage, lastTimestamp });
      await refreshGroups(userId);
      return group;
    },
    [refreshGroups]
  );

  // Marks any unread incoming messages in a thread as READ and tells the
  // sender(s), so their bubble turns into a blue double-tick.
  const markThreadRead = useCallback(async (userId: string, threadKey: string, socket: Socket) => {
    const history = await getMessages(userId, threadKey);
    const unread = history.filter((m) => m.direction === "in" && m.status !== "READ");
    for (const m of unread) {
      await sendReceipt(socket, m.id, "READ");
    }
  }, []);

  useEffect(() => {
    const existing = loadSession();
    if (!existing) {
      router.replace("/login");
      return;
    }
    setSession(existing);
  }, [router]);

  // Paint whatever we already have on disk immediately, before touching
  // the network at all — like WhatsApp, the chat list should never be
  // blank just because the socket/inbox catch-up below hasn't finished
  // (or can't, offline). The init effect below still reconciles with the
  // server once it's able to.
  useEffect(() => {
    if (!session) return;
    refreshConversations(session.userId);
    refreshGroups(session.userId);
  }, [session, refreshConversations, refreshGroups]);

  // Register this device for push once we know who's logged in — a no-op
  // outside the native Android shell (see registerForPushNotifications).
  useEffect(() => {
    if (!session) return;
    registerForPushNotifications((fcmToken) => {
      registerPushToken(session.token, fcmToken).catch((err) => console.error("Failed to register push token:", err));
    });
  }, [session]);

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
      socket.on("disconnect", () => {
        setConnected(false);
        if (callIdRef.current) failCall("Disconnected.");
      });

      socket.on("signal:message", async (msg: InboundSignalMessage) => {
        try {
          const rawPlaintext = await client.decryptMessage(msg.senderId, {
            ciphertext: msg.ciphertext,
            signalMessageType: msg.signalMessageType,
          });
          const { text: plaintext, replyTo, file } = decodeEnvelope(rawPlaintext);
          playReceivedTone();

          if (msg.groupId) {
            const group = await ensureGroup(
              session.userId,
              session.token,
              msg.groupId,
              summarize(msg.kind, msg.viewOnce, plaintext, file?.name),
              msg.timestamp
            );
            const senderUsername = group.members.find((m) => m.userId === msg.senderId)?.username ?? "Unknown";
            await appendMessage(session.userId, groupThreadKey(msg.groupId), {
              id: msg.id,
              direction: "in",
              body: plaintext,
              timestamp: msg.timestamp,
              status: "DELIVERED",
              viewOnce: msg.viewOnce,
              kind: msg.kind,
              senderId: msg.senderId,
              senderUsername,
              replyTo,
              file,
            });

            if (activeGroupRef.current?.groupId === msg.groupId) {
              setMessages(await getMessages(session.userId, groupThreadKey(msg.groupId)));
              await sendReceipt(socket, msg.id, "READ");
            } else {
              await incrementGroupUnread(session.userId, msg.groupId);
            }
            await refreshGroups(session.userId);
          } else {
            await ensureConversation(
              session.userId,
              session.token,
              msg.senderId,
              summarize(msg.kind, msg.viewOnce, plaintext, file?.name),
              msg.timestamp
            );
            await appendMessage(session.userId, msg.senderId, {
              id: msg.id,
              direction: "in",
              body: plaintext,
              timestamp: msg.timestamp,
              status: "DELIVERED",
              viewOnce: msg.viewOnce,
              kind: msg.kind,
              replyTo,
              file,
            });

            if (activePeerRef.current?.peerId === msg.senderId) {
              setMessages(await getMessages(session.userId, msg.senderId));
              await sendReceipt(socket, msg.id, "READ");
            } else {
              await incrementUnread(session.userId, msg.senderId);
            }
            await refreshConversations(session.userId);
          }
        } catch (err) {
          console.error(`Failed to process incoming message ${msg.id}:`, err);
        }
        await sendReceipt(socket, msg.id, "DELIVERED");
      });

      socket.on("signal:receipt", async (evt: SignalReceiptEvent) => {
        try {
          // We don't know here whether `evt.from` is a 1:1 peer or a group
          // member — try both; only one will actually hold this message id.
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

      socket.on("call:incoming", (evt: IncomingCallEvent) => {
        // No call-waiting for this first pass — a second inbound call while
        // one is already active/ringing is just declined as busy.
        if (callIdRef.current) {
          socket.emit("call:reject", { toUserId: evt.fromUserId, callId: evt.callId });
          return;
        }
        callIdRef.current = evt.callId;
        callDirectionRef.current = "incoming";
        pendingOfferRef.current = evt.sdp;
        setCallPeer({ userId: evt.fromUserId, username: evt.fromUsername });
        setCallError(null);
        setCallStatus("incoming");
        startCallAudioRouting();
        if (!callRingtoneRef.current) callRingtoneRef.current = new RingtonePlayer();
        callRingtoneRef.current.start("incoming");
      });

      socket.on("call:answered", async (evt: CallAnsweredEvent) => {
        if (callIdRef.current !== evt.callId) return;
        try {
          await callClientRef.current?.applyAnswer(evt.sdp);
        } catch {
          failCall("Call failed to connect.");
        }
      });

      socket.on("call:ice", (evt: CallIceEvent) => {
        if (callIdRef.current !== evt.callId) return;
        callClientRef.current?.addRemoteIceCandidate(evt.candidate);
      });

      socket.on("call:rejected", (evt: CallEndedEvent) => {
        if (callIdRef.current !== evt.callId) return;
        failCall("Call declined.");
      });

      socket.on("call:ended", (evt: CallEndedEvent) => {
        if (callIdRef.current !== evt.callId) return;
        resetCallState();
      });

      // Sync our group roster from the server (covers being added to a
      // group, or a role change, since we last logged in).
      try {
        const serverGroups = await listGroups(session.token);
        for (const g of serverGroups) {
          await upsertGroup(session.userId, {
            groupId: g.groupId,
            name: g.name,
            avatarUrl: g.avatarUrl,
            members: g.members,
          });
        }
      } catch (err) {
        console.error("Failed to sync groups:", err);
      }

      // Catch up on anything sent while we were offline. Each message is
      // handled independently — one bad/undecryptable message (e.g. a key
      // already consumed by an earlier interrupted attempt) must not take
      // down the rest of the catch-up batch or block startup. And the
      // fetch itself must not be fatal either — offline, this should just
      // leave the already-rendered local cache alone rather than bounce
      // the whole page back to a full-screen error (see the effect above
      // that paints local data before any of this network work runs).
      let pending: Awaited<ReturnType<typeof fetchInbox>> = [];
      try {
        pending = await fetchInbox(session.token);
      } catch (err) {
        console.error("Failed to fetch inbox:", err);
      }
      for (const msg of pending) {
        try {
          const rawPlaintext = await client.decryptMessage(msg.senderId, {
            ciphertext: msg.ciphertext,
            signalMessageType: msg.signalMessageType,
          });
          const { text: plaintext, replyTo, file } = decodeEnvelope(rawPlaintext);
          if (msg.groupId) {
            const group = await ensureGroup(
              session.userId,
              session.token,
              msg.groupId,
              summarize(msg.kind, msg.viewOnce, plaintext, file?.name),
              msg.timestamp
            );
            const senderUsername = group.members.find((m) => m.userId === msg.senderId)?.username ?? "Unknown";
            await appendMessage(session.userId, groupThreadKey(msg.groupId), {
              id: msg.id,
              direction: "in",
              body: plaintext,
              timestamp: msg.timestamp,
              status: "DELIVERED",
              viewOnce: msg.viewOnce,
              kind: msg.kind,
              senderId: msg.senderId,
              senderUsername,
              replyTo,
              file,
            });
            await incrementGroupUnread(session.userId, msg.groupId);
          } else {
            await ensureConversation(
              session.userId,
              session.token,
              msg.senderId,
              summarize(msg.kind, msg.viewOnce, plaintext, file?.name),
              msg.timestamp
            );
            await appendMessage(session.userId, msg.senderId, {
              id: msg.id,
              direction: "in",
              body: plaintext,
              timestamp: msg.timestamp,
              status: "DELIVERED",
              viewOnce: msg.viewOnce,
              kind: msg.kind,
              replyTo,
              file,
            });
            await incrementUnread(session.userId, msg.senderId);
          }
        } catch (err) {
          console.error(`Failed to process inbox message ${msg.id}, skipping:`, err);
        }
        // Ack regardless of decrypt success so an undecryptable message
        // doesn't keep re-appearing in the inbox on every future login.
        await sendReceipt(socket, msg.id, "DELIVERED");
      }

      await refreshConversations(session.userId);
      await refreshGroups(session.userId);
    }

    init().catch((err) => {
      console.error(err);
      setStatusMessage(err instanceof Error ? err.message : "Failed to initialize.");
    });

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      callClientRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight });
  }, [messages]);

  const threadViews = useMemo<ThreadView[]>(() => {
    const convViews: ThreadView[] = conversations.map((c) => ({
      key: c.peerId,
      isGroup: false,
      name: c.peerUsername,
      avatarUrl: c.peerAvatarUrl,
      lastMessage: c.lastMessage,
      lastTimestamp: c.lastTimestamp,
      favourite: c.favourite,
      unreadCount: c.unreadCount,
    }));
    const groupViews: ThreadView[] = groups.map((g) => ({
      key: g.groupId,
      isGroup: true,
      name: g.name,
      avatarUrl: g.avatarUrl,
      lastMessage: g.lastMessage,
      lastTimestamp: g.lastTimestamp,
      favourite: g.favourite,
      unreadCount: g.unreadCount,
    }));

    let combined = chatFilter === "groups" ? groupViews : [...convViews, ...groupViews];
    if (chatFilter === "unread") combined = combined.filter((t) => (t.unreadCount ?? 0) > 0);
    if (chatFilter === "favourites") combined = combined.filter((t) => t.favourite);

    const query = searchQuery.trim().toLowerCase();
    if (query) combined = combined.filter((t) => t.name.toLowerCase().includes(query));

    return combined.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
  }, [conversations, groups, chatFilter, searchQuery]);

  async function handleSelectConversation(conv: Conversation) {
    if (!session) return;
    setActiveGroup(null);
    setActivePeer(conv);
    setShowEmojiPicker(false);
    setReplyingTo(null);
    setShowContactDetails(false);
    setMessages(await getMessages(session.userId, conv.peerId));
    if (socketRef.current) {
      await markThreadRead(session.userId, conv.peerId, socketRef.current);
      await clearUnread(session.userId, conv.peerId);
      await refreshConversations(session.userId);
    }
  }

  async function handleSelectGroup(group: LocalGroup) {
    if (!session) return;
    setActivePeer(null);
    setActiveGroup(group);
    setShowEmojiPicker(false);
    setReplyingTo(null);
    setShowContactDetails(false);
    setMessages(await getMessages(session.userId, groupThreadKey(group.groupId)));
    if (socketRef.current) {
      await markThreadRead(session.userId, groupThreadKey(group.groupId), socketRef.current);
      await clearGroupUnread(session.userId, group.groupId);
      await refreshGroups(session.userId);
    }
  }

  function handleSelectThread(t: ThreadView) {
    if (t.isGroup) {
      const group = groups.find((g) => g.groupId === t.key);
      if (group) handleSelectGroup(group);
    } else {
      const conv = conversations.find((c) => c.peerId === t.key);
      if (conv) handleSelectConversation(conv);
    }
  }

  // On narrow viewports the sidebar and the open thread share one screen's
  // worth of space (see the `has-active-thread` media query), so there has
  // to be a way back to the list besides picking another conversation.
  function handleBackToList() {
    setActivePeer(null);
    setActiveGroup(null);
    setShowContactDetails(false);
  }

  async function handleToggleFavourite(e: React.MouseEvent, t: ThreadView) {
    e.stopPropagation();
    if (!session) return;
    if (t.isGroup) {
      await toggleGroupFavourite(session.userId, t.key);
      await refreshGroups(session.userId);
    } else {
      await toggleFavourite(session.userId, t.key);
      await refreshConversations(session.userId);
    }
  }

  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    setSearchError(null);

    const username = searchQuery.trim();
    if (!username) return;

    const existingMatch = conversations.find((c) => c.peerUsername.toLowerCase() === username.toLowerCase());
    if (existingMatch) {
      await handleSelectConversation(existingMatch);
      return;
    }

    if (username === session.username) {
      setSearchError("That's you.");
      return;
    }

    try {
      const found = await lookupUsername(session.token, username);
      const conv: Conversation = {
        peerId: found.userId,
        peerUsername: found.username,
        peerAvatarUrl: found.avatarUrl,
        lastMessage: "",
        lastTimestamp: new Date().toISOString(),
      };
      await upsertConversation(session.userId, conv);
      await refreshConversations(session.userId);
      await handleSelectConversation(conv);
      setSearchQuery("");
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "User not found.");
    }
  }

  async function sendToActiveThread(
    body: string,
    kind: "TEXT" | "VOICE" | "FILE",
    replyTo?: ReplyRef,
    file?: FileMeta
  ) {
    if (!session || !clientRef.current || !socketRef.current) return;
    const wasViewOnce = viewOnceArmed && kind === "TEXT";
    const wireBody = encodeEnvelope(body, { replyTo, file });

    if (activeGroup) {
      const others = activeGroup.members.filter((m) => m.userId !== session.userId);
      let localId: string | null = null;
      for (const member of others) {
        const envelope = await clientRef.current.encryptMessage(member.userId, wireBody);
        const ack = await sendSignalMessage(socketRef.current, {
          recipientId: member.userId,
          ciphertext: envelope.ciphertext,
          signalMessageType: envelope.signalMessageType,
          kind,
          groupId: activeGroup.groupId,
        });
        if (ack.ok && !localId) localId = ack.messageId ?? null;
      }
      const timestamp = new Date().toISOString();
      await appendMessage(session.userId, groupThreadKey(activeGroup.groupId), {
        id: localId ?? crypto.randomUUID(),
        direction: "out",
        body,
        timestamp,
        status: "SENT",
        kind,
        senderId: session.userId,
        senderUsername: session.username,
        replyTo,
        file,
      });
      await upsertGroup(session.userId, {
        groupId: activeGroup.groupId,
        lastMessage: summarize(kind, false, body, file?.name),
        lastTimestamp: timestamp,
      });
      await refreshGroups(session.userId);
      setMessages(await getMessages(session.userId, groupThreadKey(activeGroup.groupId)));
      playSentTone();
      return;
    }

    if (!activePeer) return;
    const envelope = await clientRef.current.encryptMessage(activePeer.peerId, wireBody);
    const ack = await sendSignalMessage(socketRef.current, {
      recipientId: activePeer.peerId,
      ciphertext: envelope.ciphertext,
      signalMessageType: envelope.signalMessageType,
      viewOnce: wasViewOnce,
      kind,
    });

    if (!ack.ok || !ack.messageId) {
      throw new Error(ack.error ?? "Failed to send message.");
    }

    const timestamp = new Date().toISOString();
    await appendMessage(session.userId, activePeer.peerId, {
      id: ack.messageId,
      direction: "out",
      body,
      timestamp,
      status: "SENT",
      viewOnce: wasViewOnce,
      kind,
      replyTo,
      file,
    });
    await upsertConversation(session.userId, {
      peerId: activePeer.peerId,
      lastMessage: summarize(kind, wasViewOnce, body, file?.name),
      lastTimestamp: timestamp,
    });
    await refreshConversations(session.userId);
    setMessages(await getMessages(session.userId, activePeer.peerId));
    playSentTone();
  }

  // Label shown above the quoted snippet, from the replying user's point of
  // view: "You" for their own earlier message, otherwise the original sender.
  function replySenderLabelFor(m: LocalMessage): string {
    if (m.direction === "out") return "You";
    return m.senderUsername ?? activePeer?.peerUsername ?? "Unknown";
  }

  function buildReplyRef(m: LocalMessage): ReplyRef {
    return {
      messageId: m.id,
      senderLabel: replySenderLabelFor(m),
      preview: summarize(m.kind ?? "TEXT", m.viewOnce, m.body, m.file?.name),
    };
  }

  function handleReplyToMessage(message: LocalMessage) {
    setReplyingTo(message);
    composerInputRef.current?.focus();
  }

  async function handleDeleteMessage(messageId: string) {
    if (!session) return;
    const threadKey = activeGroup ? groupThreadKey(activeGroup.groupId) : activePeer?.peerId;
    if (!threadKey) return;

    await deleteMessage(session.userId, threadKey, messageId);
    const updated = await getMessages(session.userId, threadKey);
    setMessages(updated);

    const last = updated[updated.length - 1];
    const lastMessage = last ? summarize(last.kind ?? "TEXT", last.viewOnce, last.body, last.file?.name) : "";
    const lastTimestamp = last ? last.timestamp : new Date().toISOString();
    if (activeGroup) {
      await upsertGroup(session.userId, { groupId: activeGroup.groupId, lastMessage, lastTimestamp });
      await refreshGroups(session.userId);
    } else if (activePeer) {
      await upsertConversation(session.userId, { peerId: activePeer.peerId, lastMessage, lastTimestamp });
      await refreshConversations(session.userId);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      const replyRef = replyingTo ? buildReplyRef(replyingTo) : undefined;
      await sendToActiveThread(text, "TEXT", replyRef);
      setDraft("");
      setViewOnceArmed(false);
      setReplyingTo(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  async function handleVoiceRecorded(dataUrl: string) {
    setSending(true);
    try {
      const replyRef = replyingTo ? buildReplyRef(replyingTo) : undefined;
      await sendToActiveThread(dataUrl, "VOICE", replyRef);
      setReplyingTo(null);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  async function handleFileSelected(dataUrl: string, meta: FileMeta) {
    setSending(true);
    try {
      const replyRef = replyingTo ? buildReplyRef(replyingTo) : undefined;
      await sendToActiveThread(dataUrl, "FILE", replyRef, meta);
      setReplyingTo(null);
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

  // --- Voice calls ---
  // 1:1 only for this first pass — group calls would need an N-way mesh of
  // peer connections, which is a much bigger step. Signaling (SDP/ICE) rides
  // the existing socket, addressed by userId exactly like signal:message;
  // the audio itself never touches the server (see lib/callClient.ts).

  function formatCallDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // Calls leave no server-side history (see call.gateway.ts), so each side
  // logs its own local record of how the call ended — purely from what it
  // already knows, no extra message needs to be sent to the peer.
  async function logCallOutcome() {
    if (!session) return;
    const peer = callPeerRef.current;
    const direction = callDirectionRef.current;
    if (!peer || !direction) return;

    const wasConnected = callStatusRef.current === "connected" || callDurationRef.current > 0;
    let body: string;
    if (wasConnected) {
      body = `📞 Voice call · ${formatCallDuration(callDurationRef.current)}`;
    } else if (direction === "outgoing") {
      body = "📞 No answer";
    } else {
      body = "📞 Missed voice call";
    }

    const timestamp = new Date().toISOString();
    await appendMessage(session.userId, peer.userId, {
      id: crypto.randomUUID(),
      direction: direction === "outgoing" ? "out" : "in",
      body,
      timestamp,
      status: "DELIVERED",
      kind: "CALL",
    });
    await upsertConversation(session.userId, { peerId: peer.userId, lastMessage: body, lastTimestamp: timestamp });
    await refreshConversations(session.userId);
    if (activePeerRef.current?.peerId === peer.userId) {
      setMessages(await getMessages(session.userId, peer.userId));
    }
  }

  function attachRemoteStream(stream: MediaStream) {
    callRingtoneRef.current?.stop();
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.play().catch(() => {
        // Autoplay-with-sound is often blocked this soon after a user
        // gesture (accepting/placing the call) — surface a one-tap unlock
        // instead of silently leaving the call audible-but-silent.
        setCallNeedsAudioUnlock(true);
      });
    }
    if (callRingTimeoutRef.current) {
      clearTimeout(callRingTimeoutRef.current);
      callRingTimeoutRef.current = null;
    }
    setCallDuration(0);
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    callTimerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000);
    setCallStatus("connected");
  }

  function handleUnlockCallAudio() {
    remoteAudioRef.current?.play().catch(() => {});
    setCallNeedsAudioUnlock(false);
  }

  function resetCallState() {
    callRingtoneRef.current?.stop();
    stopCallAudioRouting();
    logCallOutcome().catch((err) => console.error("Failed to log call outcome:", err));
    callDirectionRef.current = null;
    callClientRef.current?.dispose();
    callClientRef.current = null;
    callIdRef.current = null;
    pendingOfferRef.current = null;
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    callTimerRef.current = null;
    if (callRingTimeoutRef.current) clearTimeout(callRingTimeoutRef.current);
    callRingTimeoutRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setCallStatus(null);
    setCallPeer(null);
    setCallDuration(0);
    setCallMuted(false);
    setCallNeedsAudioUnlock(false);
  }

  // Used for both "the other side hung up/declined/failed" and "something
  // broke locally" — either way the call is over, so show why for a moment
  // and then tear the whole thing down.
  function failCall(message: string) {
    callRingtoneRef.current?.stop();
    setCallError(message);
    if (callErrorTimeoutRef.current) clearTimeout(callErrorTimeoutRef.current);
    callErrorTimeoutRef.current = setTimeout(() => {
      resetCallState();
      setCallError(null);
    }, 2500);
  }

  async function startVoiceCall(peer: Conversation) {
    if (!socketRef.current || callIdRef.current) return;
    const socket = socketRef.current;
    const callId = crypto.randomUUID();
    callIdRef.current = callId;
    callDirectionRef.current = "outgoing";
    setCallPeer({ userId: peer.peerId, username: peer.peerUsername, avatarUrl: peer.peerAvatarUrl });
    setCallError(null);
    setCallStatus("outgoing");
    startCallAudioRouting();

    const client = new CallClient(socket, peer.peerId, callId, {
      onRemoteStream: attachRemoteStream,
      onFailure: failCall,
    });
    callClientRef.current = client;

    try {
      const offer = await client.startAsCaller();
      const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socket.emit("call:invite", { toUserId: peer.peerId, callId, sdp: offer }, resolve);
      });
      if (!ack.ok) {
        failCall(ack.error ?? "Couldn't place the call.");
        return;
      }
      if (!callRingtoneRef.current) callRingtoneRef.current = new RingtonePlayer();
      callRingtoneRef.current.start("outgoing");
      callRingTimeoutRef.current = setTimeout(() => {
        socket.emit("call:end", { toUserId: peer.peerId, callId });
        failCall("No answer.");
      }, 30000);
    } catch (err) {
      failCall(err instanceof Error ? err.message : "Couldn't access your microphone.");
    }
  }

  async function handleAcceptCall() {
    if (!socketRef.current || !callPeer || !callIdRef.current || !pendingOfferRef.current) return;
    callRingtoneRef.current?.stop();
    const socket = socketRef.current;
    const peerUserId = callPeer.userId;
    const callId = callIdRef.current;
    const offer = pendingOfferRef.current;

    const client = new CallClient(socket, peerUserId, callId, {
      onRemoteStream: attachRemoteStream,
      onFailure: failCall,
    });
    callClientRef.current = client;

    try {
      const answer = await client.acceptAsCallee(offer);
      pendingOfferRef.current = null;
      socket.emit("call:answer", { toUserId: peerUserId, callId, sdp: answer });
    } catch (err) {
      failCall(err instanceof Error ? err.message : "Couldn't access your microphone.");
    }
  }

  function handleDeclineCall() {
    if (socketRef.current && callPeer && callIdRef.current) {
      const event = callStatus === "incoming" ? "call:reject" : "call:end";
      socketRef.current.emit(event, { toUserId: callPeer.userId, callId: callIdRef.current });
    }
    resetCallState();
  }

  function toggleCallMute() {
    const next = !callMuted;
    callClientRef.current?.setMuted(next);
    setCallMuted(next);
  }

  async function handleCreateGroup(name: string, memberUserIds: string[]) {
    if (!session) return;
    const created = await createGroupApi(session.token, name, memberUserIds);
    const group: LocalGroup = {
      groupId: created.groupId,
      name: created.name,
      avatarUrl: created.avatarUrl,
      members: created.members,
      lastMessage: "",
      lastTimestamp: new Date().toISOString(),
    };
    await upsertGroup(session.userId, group);
    await refreshGroups(session.userId);
    await handleSelectGroup(group);
  }

  async function handleAddGroupMember(userId: string) {
    if (!session || !activeGroup) return;
    const updated = await addGroupMember(session.token, activeGroup.groupId, userId);
    const group: LocalGroup = { ...activeGroup, members: updated.members };
    setActiveGroup(group);
    await upsertGroup(session.userId, group);
    await refreshGroups(session.userId);
  }

  async function handleRemoveGroupMember(userId: string) {
    if (!session || !activeGroup) return;
    await removeGroupMember(session.token, activeGroup.groupId, userId);
    const group: LocalGroup = { ...activeGroup, members: activeGroup.members.filter((m) => m.userId !== userId) };
    setActiveGroup(group);
    await upsertGroup(session.userId, group);
    await refreshGroups(session.userId);
  }

  async function handleSetMemberRole(userId: string, role: "ADMIN" | "MEMBER") {
    if (!session || !activeGroup) return;
    await updateGroupMemberRole(session.token, activeGroup.groupId, userId, role);
    const group: LocalGroup = {
      ...activeGroup,
      members: activeGroup.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
    };
    setActiveGroup(group);
    await upsertGroup(session.userId, group);
    await refreshGroups(session.userId);
  }

  async function handleLeaveGroup() {
    if (!session || !activeGroup) return;
    await removeGroupMember(session.token, activeGroup.groupId, session.userId);
    setShowGroupInfoModal(false);
    setActiveGroup(null);
    setMessages([]);
    await refreshGroups(session.userId);
  }

  async function handleSaveProfile(patch: { avatarUrl?: string | null; statusText?: string | null }) {
    if (!session) return;
    const updated = await updateProfile(session.token, patch);
    const nextSession: Session = { ...session, avatarUrl: updated.avatarUrl, statusText: updated.statusText };
    setSession(nextSession);
    localStorage.setItem("matrix-chat-session", JSON.stringify(nextSession));
  }

  function handleLogout() {
    callClientRef.current?.dispose();
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

  const filterTabs: { key: ChatFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "unread", label: "Unread" },
    { key: "favourites", label: "Favourites" },
    { key: "groups", label: "Groups" },
  ];

  const activeKey = activeGroup?.groupId ?? activePeer?.peerId ?? null;

  return (
    <div className={`chat-shell ${activePeer || activeGroup ? "has-active-thread" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand-bar">
          <span className="sidebar-brand-logo" aria-hidden="true">🔒</span>
          <span className="sidebar-brand-name">Matrix Chat</span>
        </div>
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
        </div>

        <div className="chats-toolbar">
          <h2 className="chats-title">Chats</h2>
          <div className="chats-toolbar-actions">
            <div className="kebab-wrap">
              <button className="composer-icon-btn" onClick={() => setShowMenu((v) => !v)} aria-label="Menu">
                ⋮
              </button>
              {showMenu && (
                <>
                  <div className="menu-backdrop" onClick={() => setShowMenu(false)} />
                  <div className="dropdown-menu">
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setShowMenu(false);
                        setShowNewGroupModal(true);
                      }}
                    >
                      New group
                    </button>
                    <button className="dropdown-item" onClick={handleLogout}>
                      Log out
                    </button>
                  </div>
                </>
              )}
            </div>
            <button className="new-chat-fab" onClick={() => searchInputRef.current?.focus()} aria-label="New chat">
              +
            </button>
          </div>
        </div>

        <form className="chat-search-row" onSubmit={handleSearchSubmit}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="M20 20l-4.8-4.8" strokeLinecap="round" />
          </svg>
          <input
            ref={searchInputRef}
            placeholder="Search or start a new chat"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchError(null);
            }}
          />
        </form>
        {searchError && <div className="inline-error">{searchError}</div>}

        <div className="chat-filter-tabs">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              className={`filter-tab ${chatFilter === tab.key ? "active" : ""}`}
              onClick={() => setChatFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="conversation-list">
          {threadViews.length === 0 ? (
            <div className="empty-conversations">
              {chatFilter === "groups"
                ? "No groups yet. Use the menu to create one."
                : conversations.length === 0 && groups.length === 0
                ? "No conversations yet. Search a username above to start one."
                : "No matches."}
            </div>
          ) : (
            threadViews.map((t) => (
              <div
                key={t.key}
                className={`conversation-item ${activeKey === t.key ? "active" : ""}`}
                onClick={() => handleSelectThread(t)}
              >
                <Avatar name={t.name} avatarUrl={t.avatarUrl} size={44} />
                <span className="conversation-text">
                  <span className="peer">
                    {t.isGroup && "👥 "}
                    {t.name}
                  </span>
                  <span className="preview">{t.lastMessage || "No messages yet"}</span>
                </span>
                <span className="conversation-meta-col">
                  <button
                    className={`star-btn ${t.favourite ? "starred" : ""}`}
                    onClick={(e) => handleToggleFavourite(e, t)}
                    aria-label="Toggle favourite"
                  >
                    {t.favourite ? "★" : "☆"}
                  </button>
                  {!!t.unreadCount && <span className="unread-badge">{t.unreadCount}</span>}
                </span>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="chat-main">
        {!activePeer && !activeGroup ? (
          <div className="chat-empty-state">Select a conversation or start a new one to begin an encrypted chat.</div>
        ) : (
          <>
          <div className="chat-thread-col">
            <div className="chat-header">
              <button type="button" className="chat-back-btn" onClick={handleBackToList} aria-label="Back to chats">
                ←
              </button>
              <div className="chat-header-clickable" onClick={() => setShowContactDetails(true)}>
                <Avatar
                  name={activeGroup ? activeGroup.name : activePeer!.peerUsername}
                  avatarUrl={activeGroup ? activeGroup.avatarUrl : activePeer!.peerAvatarUrl}
                  size={38}
                />
                <span className="chat-header-text">
                  <span className="chat-header-name">{activeGroup ? activeGroup.name : activePeer!.peerUsername}</span>
                  <span className="lock">
                    {activeGroup ? `${activeGroup.members.length} members` : "🔒 End-to-end encrypted"}
                  </span>
                </span>
              </div>
              <div className="chat-header-actions">
                {!activeGroup && (
                  <button
                    type="button"
                    className="chat-info-btn"
                    onClick={() => activePeer && startVoiceCall(activePeer)}
                    disabled={!!callStatus}
                    aria-label="Voice call"
                    title="Voice call"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                      <path d="M6.6 10.8c1.4 2.8 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1L6.6 10.8z" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  className={`chat-info-btn ${showContactDetails ? "active" : ""}`}
                  onClick={() => setShowContactDetails((v) => !v)}
                  aria-label="Contact details"
                  title="Contact details"
                >
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11v5.5" strokeLinecap="round" />
                    <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="message-list" ref={messageListRef}>
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  onOpenViewOnce={handleOpenViewOnce}
                  showSender={!!activeGroup}
                  onReply={handleReplyToMessage}
                  onDelete={handleDeleteMessage}
                />
              ))}
            </div>
            {replyingTo && (
              <div className="reply-preview-bar">
                <div className="reply-preview-accent" />
                <div className="reply-preview-text">
                  <span className="reply-preview-sender">{replySenderLabelFor(replyingTo)}</span>
                  <span className="reply-preview-body">
                    {summarize(replyingTo.kind ?? "TEXT", replyingTo.viewOnce, replyingTo.body, replyingTo.file?.name)}
                  </span>
                </div>
                <button
                  type="button"
                  className="reply-preview-close"
                  onClick={() => setReplyingTo(null)}
                  aria-label="Cancel reply"
                >
                  ✕
                </button>
              </div>
            )}
            <form className="composer" onSubmit={handleSend}>
              <div className={`composer-input-pill ${isVoiceRecording ? "composer-input-pill-recording" : ""}`}>
                {!isVoiceRecording && (
                  <>
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
                    <FileAttachButton onFileSelected={handleFileSelected} disabled={sending} />
                    <input
                      ref={composerInputRef}
                      placeholder={viewOnceArmed ? "View-once message..." : "Type a message"}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      disabled={sending}
                    />
                    {!activeGroup && (
                      <button
                        type="button"
                        className={`composer-emoji-btn ${viewOnceArmed ? "armed" : ""}`}
                        onClick={() => setViewOnceArmed((v) => !v)}
                        aria-label="Toggle view-once"
                        title="Send as view-once"
                      >
                        {viewOnceArmed ? "1️⃣" : "👁"}
                      </button>
                    )}
                  </>
                )}
                {!isVoiceRecording && draft.trim() ? (
                  <button type="submit" className="composer-send-btn" disabled={sending}>
                    ➤
                  </button>
                ) : (
                  <VoiceRecorderButton
                    onRecorded={handleVoiceRecorded}
                    disabled={sending}
                    onRecordingChange={setIsVoiceRecording}
                  />
                )}
              </div>
            </form>
          </div>
          {showContactDetails && (
            <ContactDetailsPanel
              name={activeGroup ? activeGroup.name : activePeer!.peerUsername}
              avatarUrl={activeGroup ? activeGroup.avatarUrl : activePeer!.peerAvatarUrl}
              status={activeGroup ? `${activeGroup.members.length} members` : "🔒 End-to-end encrypted"}
              messages={messages}
              onManageGroup={
                activeGroup
                  ? () => {
                      setShowContactDetails(false);
                      setShowGroupInfoModal(true);
                    }
                  : undefined
              }
              onClose={() => setShowContactDetails(false)}
            />
          )}
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

      {showNewGroupModal && (
        <NewGroupModal
          token={session.token}
          myUsername={session.username}
          onCreate={handleCreateGroup}
          onClose={() => setShowNewGroupModal(false)}
        />
      )}

      {showGroupInfoModal && activeGroup && (
        <GroupInfoModal
          group={activeGroup}
          myUserId={session.userId}
          token={session.token}
          onAddMember={handleAddGroupMember}
          onRemoveMember={handleRemoveGroupMember}
          onSetRole={handleSetMemberRole}
          onLeave={handleLeaveGroup}
          onClose={() => setShowGroupInfoModal(false)}
        />
      )}

      {callStatus && callPeer && (
        <CallOverlay
          status={callStatus}
          peerUsername={callPeer.username}
          peerAvatarUrl={callPeer.avatarUrl}
          duration={callDuration}
          muted={callMuted}
          error={callError}
          needsAudioUnlock={callNeedsAudioUnlock}
          onAccept={handleAcceptCall}
          onDecline={handleDeclineCall}
          onToggleMute={toggleCallMute}
          onUnlockAudio={handleUnlockCallAudio}
        />
      )}
      <audio ref={remoteAudioRef} autoPlay hidden />
      {showExitPrompt && <div className="exit-prompt-toast">Press back again to exit</div>}
    </div>
  );
}

function summarize(
  kind: "TEXT" | "VOICE" | "FILE" | "CALL",
  viewOnce: boolean | undefined,
  plaintext: string,
  fileName?: string
): string {
  if (kind === "CALL") return plaintext;
  if (kind === "FILE") return `📎 ${fileName ?? "Attachment"}`;
  if (kind === "VOICE") return "🎤 Voice message";
  if (viewOnce) return "📷 View once photo";
  return plaintext;
}
