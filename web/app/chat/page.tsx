"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Socket } from "socket.io-client";
import { clearSession, loadSession, Session } from "@/lib/auth";
import {
  addGroupMember,
  createGroup as createGroupApi,
  fetchInbox,
  fetchPresence,
  fetchPresenceBatch,
  getGroup,
  listGroups,
  lookupUsername,
  PresenceInfo,
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
  PresenceUpdateEvent,
  sendReceipt,
  sendSignalMessage,
  sendTyping,
  sendViewed,
  sendVisibility,
  SignalReceiptEvent,
  SignalTypingEvent,
  SignalViewedEvent,
} from "@/lib/socket";
import { SignalClient } from "@/lib/signal/signalClient";
import { CallClient } from "@/lib/callClient";
import { RingtonePlayer } from "@/lib/ringtone";
import { setCallSpeaker, startCallAudioRouting, stopCallAudioRouting } from "@/lib/callAudio";
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
import { CALL_REACTION_LIFETIME_MS, CallReaction } from "@/components/CallReactions";
import { VoiceRecorderButton } from "@/components/VoiceRecorderButton";
import { FileAttachButton } from "@/components/FileAttachButton";
import {
  AttachmentError,
  INLINE_MAX_BYTES,
  cacheFile,
  deleteCachedFile,
  setAttachmentAuth,
  uploadAttachment,
} from "@/lib/attachments";
import { ImageViewer } from "@/components/ImageViewer";

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
  // Thread key (peerId for 1:1, groupId for a group) -> usernames currently
  // composing in that thread. A ThreadView's `key` uses this same scheme.
  const [typingByThread, setTypingByThread] = useState<Record<string, string[]>>({});
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, PresenceInfo>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [showMenu, setShowMenu] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // A heavy file being encrypted and uploaded (or that failed to): drives the
  // progress strip above the composer.
  const [fileTransfer, setFileTransfer] = useState<{ name: string; progress: number; error?: string } | null>(null);
  const fileUploadAbortRef = useRef<AbortController | null>(null);
  const [viewOnceArmed, setViewOnceArmed] = useState(false);
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [viewerMessage, setViewerMessage] = useState<LocalMessage | null>(null);
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
  const [callPeerMuted, setCallPeerMuted] = useState(false);
  // Speakerphone is the default route (see CallAudioPlugin.start) -- an earpiece
  // route is near-inaudible unless the phone is held to the ear.
  const [callSpeakerOn, setCallSpeakerOn] = useState(true);
  const [callRinging, setCallRinging] = useState(false);
  const [callConnecting, setCallConnecting] = useState(false);
  const [callMinimized, setCallMinimized] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [callNeedsAudioUnlock, setCallNeedsAudioUnlock] = useState(false);
  // Video calls: our own camera stream (self-view), the peer's stream (its
  // video track feeds the big picture; its audio plays via the <audio> below),
  // and whether each side's camera is currently on.
  const [callVideo, setCallVideo] = useState(false);
  const [callLocalStream, setCallLocalStream] = useState<MediaStream | null>(null);
  const [callRemoteStream, setCallRemoteStream] = useState<MediaStream | null>(null);
  const [callCameraOn, setCallCameraOn] = useState(false);
  const [callPeerCameraOn, setCallPeerCameraOn] = useState(false);
  const [callCanSendVideo, setCallCanSendVideo] = useState(false);
  const [callFacing, setCallFacing] = useState<"user" | "environment">("user");
  const [callReactions, setCallReactions] = useState<CallReaction[]>([]);
  // Connection health: the media path dropped and is being re-established, the
  // link is weak, and whether video was paused (mine / theirs) to cope with it.
  const [callReconnecting, setCallReconnecting] = useState(false);
  const [callWeak, setCallWeak] = useState(false);
  const [callMyVideoPaused, setCallMyVideoPaused] = useState(false);
  const [callPeerVideoPaused, setCallPeerVideoPaused] = useState(false);

  setAttachmentAuth(session ? { token: session.token, userId: session.userId } : null);

  const clientRef = useRef<SignalClient | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activePeerRef = useRef<Conversation | null>(null);
  const activeGroupRef = useRef<LocalGroup | null>(null);
  const groupsRef = useRef<LocalGroup[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const initRan = useRef(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const callClientRef = useRef<CallClient | null>(null);
  const callIdRef = useRef<string | null>(null);
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  // ICE candidates routinely arrive before the callee taps Accept (gathering
  // starts the moment the caller creates their offer, well before a human
  // notices the ring) — callClientRef.current is still null at that point,
  // so callClientRef.current?.addRemoteIceCandidate(...) would silently
  // drop every one of them with no queuing at all. Buffered here instead,
  // and flushed into the CallClient the moment it's created in
  // handleAcceptCall.
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const callDisconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callConnectedRef = useRef(false);
  const callConnectFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callMinimizedRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callRingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callRingtoneRef = useRef<RingtonePlayer | null>(null);
  // Which side of the call I was on originally — kept separately from
  // callStatus because that transitions to "connected" once answered, and
  // the call-log entry logged on teardown still needs to know.
  const callDirectionRef = useRef<"outgoing" | "incoming" | null>(null);
  const callVideoRef = useRef(false);
  // Whether the invite actually went out -- a call that failed before ringing
  // (camera/mic blocked) never reached anyone, so it isn't logged as "No answer".
  const callInviteSentRef = useRef(false);
  const lastReactionSentRef = useRef(0);
  // Who we last told "I'm typing" — cleared (and the other side told
  // "stopped") after a few seconds of no keystrokes, on send, or when the
  // active thread changes.
  const typingTargetRef = useRef<{ recipientId?: string; groupId?: string } | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-thread safety-net timers that clear a typing indicator if a
  // "stopped" event never arrives (dropped connection, killed app, etc).
  const typingClearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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
  // When the device's network comes back or changes (Wi-Fi <-> mobile), re-check
  // the call's media path straight away instead of waiting for it to time out.
  useEffect(() => {
    if (!callStatus) return;
    const onNetworkChange = () => callClientRef.current?.notifyNetworkChange();
    window.addEventListener("online", onNetworkChange);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = (navigator as any).connection as EventTarget | undefined;
    connection?.addEventListener?.("change", onNetworkChange);
    return () => {
      window.removeEventListener("online", onNetworkChange);
      connection?.removeEventListener?.("change", onNetworkChange);
    };
  }, [callStatus]);
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
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

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
  const imageViewerOpenRef = useRef(false);
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
  useEffect(() => {
    imageViewerOpenRef.current = viewerMessage !== null;
  }, [viewerMessage]);
  useEffect(() => {
    callMinimizedRef.current = callMinimized;
  }, [callMinimized]);

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
      if (imageViewerOpenRef.current) {
        setViewerMessage(null);
        return;
      }
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
      // Back during a call minimizes it to the green "return to call" bar
      // (like WhatsApp); once minimized, back navigates normally. An incoming
      // call that hasn't been answered swallows it -- dropping or ignoring a
      // ring by accident is worse than a no-op.
      if (callStatusRef.current && !callMinimizedRef.current) {
        if (callStatusRef.current !== "incoming") setCallMinimized(true);
        return;
      }
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

  // Paints the sidebar's online dots: batch-fetches presence for whichever
  // conversation peers this client doesn't already have a reading for (a new
  // conversation from a search, or the very first load). Live changes from
  // then on come from the "presence:update" socket handler instead.
  useEffect(() => {
    if (!session) return;
    const unknown = [...new Set(conversations.map((c) => c.peerId))].filter((id) => !(id in presenceByUserId));
    if (unknown.length === 0) return;
    fetchPresenceBatch(session.token, unknown)
      .then((result) => setPresenceByUserId((prev) => ({ ...result, ...prev })))
      .catch(() => {
        // No presence data for these yet -- the UI already treats "unknown"
        // the same as "not shown", so there's nothing to recover from here.
      });
    // presenceByUserId deliberately excluded — this only ever needs to fetch
    // for ids not already in it, and including it would re-fire this effect
    // every time it's the very state being set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, conversations]);

  // Register this device for push once we know who's logged in — a no-op
  // outside the native Android shell (see registerForPushNotifications).
  // Also re-runs on every foreground resume, not just a cold start — the
  // channel/token setup should be idempotent, and a user who merely
  // backgrounded the app (rather than fully killing it) would otherwise
  // never get a channel created on a device that has never opened this
  // build fresh.
  useEffect(() => {
    if (!session) return;

    // Opens whichever thread a tapped notification was actually about,
    // instead of leaving the user on whatever thread happened to be open
    // last. senderId/groupId ride along as a plain data payload on the
    // push (see push.ts) — never message content, just routing.
    async function openThreadFor(target: { senderId: string; groupId?: string }) {
      if (target.groupId) {
        const known = groupsRef.current.find((g) => g.groupId === target.groupId);
        const group = known ?? (await ensureGroup(session!.userId, session!.token, target.groupId, "", new Date().toISOString()));
        await handleSelectGroup(group);
      } else {
        const known = conversationsRef.current.find((c) => c.peerId === target.senderId);
        const conv = known ?? (await ensureConversation(session!.userId, session!.token, target.senderId, "", new Date().toISOString()));
        await handleSelectConversation(conv);
      }
    }

    const register = () => {
      registerForPushNotifications(
        (fcmToken) => {
          registerPushToken(session.token, fcmToken).catch((err) => console.error("Failed to register push token:", err));
        },
        (target) => {
          openThreadFor(target).catch((err) => console.error("Failed to open thread from notification:", err));
        }
      );
    };
    register();
    const handle = Capacitor.isNativePlatform() ? CapacitorApp.addListener("resume", register) : null;
    return () => {
      handle?.then((h) => h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Tells the server when this tab/app instance stops (or resumes) being
  // the thing the user is actually looking at, so it knows a live socket
  // isn't enough on its own to skip a push notification — see
  // isUserVisible in signal.gateway.ts. document.visibilityState covers
  // both a backgrounded Android app and an unfocused browser tab.
  useEffect(() => {
    function reportVisibility() {
      const socket = socketRef.current;
      if (socket) sendVisibility(socket, document.visibilityState === "visible");
    }

    document.addEventListener("visibilitychange", reportVisibility);
    const handle = Capacitor.isNativePlatform()
      ? CapacitorApp.addListener("appStateChange", ({ isActive }) => {
          const socket = socketRef.current;
          if (socket) sendVisibility(socket, isActive);
        })
      : null;

    return () => {
      document.removeEventListener("visibilitychange", reportVisibility);
      handle?.then((h) => h.remove());
    };
  }, []);

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

      socket.on("connect", () => {
        setConnected(true);
        // The server defaults a fresh socket to "visible" anyway, but a
        // reconnect can happen while backgrounded (e.g. the socket dropped
        // and came back while the app was still in the background) — make
        // sure the server's view matches reality from the first moment.
        sendVisibility(socket, document.visibilityState === "visible");
        if (callDisconnectTimeoutRef.current) {
          clearTimeout(callDisconnectTimeoutRef.current);
          callDisconnectTimeoutRef.current = null;
        }
      });
      socket.on("disconnect", () => {
        setConnected(false);
        // A live call's audio/video is a direct (or TURN-relayed) peer-to-peer
        // session that doesn't depend on this signaling socket, so a socket drop
        // -- routine on a phone -- must NOT end the call (it used to, after 8s,
        // which is why calls kept dying on an unstable connection). If the media
        // path is genuinely gone, the call client notices that itself, shows
        // "Reconnecting" and only gives up if it can't recover (see CallClient).
        // Anything the call needs to say meanwhile is queued by socket.io and
        // sent as soon as it reconnects.
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

      socket.on("signal:typing", (evt: SignalTypingEvent) => {
        const threadKey = evt.groupId ?? evt.from;
        const existingTimer = typingClearTimersRef.current.get(threadKey);
        if (existingTimer) clearTimeout(existingTimer);
        typingClearTimersRef.current.delete(threadKey);

        if (evt.typing) {
          setTypingByThread((prev) => {
            const current = prev[threadKey] ?? [];
            if (current.includes(evt.username)) return prev;
            return { ...prev, [threadKey]: [...current, evt.username] };
          });
          // Safety net in case a "stopped typing" event never arrives —
          // matches the sender's own inactivity timeout, plus a margin.
          const timer = setTimeout(() => {
            setTypingByThread((prev) => {
              const current = prev[threadKey];
              if (!current?.length) return prev;
              return { ...prev, [threadKey]: current.filter((u) => u !== evt.username) };
            });
          }, 5000);
          typingClearTimersRef.current.set(threadKey, timer);
        } else {
          setTypingByThread((prev) => {
            const current = prev[threadKey];
            if (!current?.length) return prev;
            return { ...prev, [threadKey]: current.filter((u) => u !== evt.username) };
          });
        }
      });

      // Live presence changes from here on -- the initial state (for anyone
      // who was already online/offline before this socket connected) comes
      // from the batch/single presence fetches below instead.
      socket.on("presence:update", (evt: PresenceUpdateEvent) => {
        setPresenceByUserId((prev) => ({ ...prev, [evt.userId]: { online: evt.online, lastSeenAt: evt.lastSeenAt } }));
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
        callVideoRef.current = evt.video === true;
        setCallVideo(evt.video === true);
        setCallPeerCameraOn(evt.video === true);
        setCallPeer({ userId: evt.fromUserId, username: evt.fromUsername });
        setCallError(null);
        setCallStatus("incoming");
        startCallAudioRouting();
        if (!callRingtoneRef.current) callRingtoneRef.current = new RingtonePlayer();
        callRingtoneRef.current.start("incoming");
      });

      socket.on("call:answered", async (evt: CallAnsweredEvent) => {
        if (callIdRef.current !== evt.callId) return;
        callRingtoneRef.current?.stop();
        setCallConnecting(true);
        try {
          await callClientRef.current?.applyAnswer(evt.sdp);
        } catch {
          failCall("Call failed to connect.");
        }
      });

      socket.on("call:peer-muted", (evt: { callId: string; muted: boolean }) => {
        if (callIdRef.current !== evt.callId) return;
        setCallPeerMuted(evt.muted);
      });

      socket.on("call:peer-camera", (evt: { callId: string; on: boolean; paused?: boolean }) => {
        if (callIdRef.current !== evt.callId) return;
        setCallPeerCameraOn(evt.on);
        setCallPeerVideoPaused(evt.paused === true);
      });

      // ICE-restart renegotiation after a network drop (see CallClient).
      socket.on("call:restart", (evt: { callId: string; sdp: RTCSessionDescriptionInit }) => {
        if (callIdRef.current !== evt.callId) return;
        callClientRef.current?.handleRestartOffer(evt.sdp);
      });
      socket.on("call:restart-answer", (evt: { callId: string; sdp: RTCSessionDescriptionInit }) => {
        if (callIdRef.current !== evt.callId) return;
        callClientRef.current?.applyRestartAnswer(evt.sdp);
      });
      socket.on("call:restart-request", (evt: { callId: string }) => {
        if (callIdRef.current !== evt.callId) return;
        callClientRef.current?.restartIce();
      });

      socket.on("call:reacted", (evt: { fromUserId: string; callId: string; emoji: string }) => {
        if (callIdRef.current !== evt.callId) return;
        pushCallReaction(evt.emoji, callPeerRef.current?.username ?? "", false);
      });

      socket.on("call:ice", (evt: CallIceEvent) => {
        if (callIdRef.current !== evt.callId) return;
        if (callClientRef.current) {
          callClientRef.current.addRemoteIceCandidate(evt.candidate);
        } else {
          pendingIceCandidatesRef.current.push(evt.candidate);
        }
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
    stopTypingIfNeeded();
    // Mirrored into the refs right now rather than waiting for the effect
    // that follows the next render: the incoming-message handler decides
    // "is this thread open?" from these refs, and in that render-sized gap it
    // would treat a thread being opened as closed -- leaving the message
    // unread and never sending the sender a read receipt.
    activePeerRef.current = conv;
    activeGroupRef.current = null;
    setActiveGroup(null);
    setActivePeer(conv);
    setShowEmojiPicker(false);
    setReplyingTo(null);
    setShowContactDetails(false);
    setMessages(await getMessages(session.userId, conv.peerId));
    // Fire-and-forget: refreshes this peer's presence right when their chat
    // is opened, rather than waiting on whatever the sidebar batch fetch
    // last happened to have (which could be stale, or never ran for them).
    fetchPresence(session.token, conv.peerId)
      .then((info) => setPresenceByUserId((prev) => ({ ...prev, [conv.peerId]: info })))
      .catch(() => {});
    if (socketRef.current) {
      await markThreadRead(session.userId, conv.peerId, socketRef.current);
      await clearUnread(session.userId, conv.peerId);
      await refreshConversations(session.userId);
    }
  }

  async function handleSelectGroup(group: LocalGroup) {
    if (!session) return;
    stopTypingIfNeeded();
    activePeerRef.current = null;
    activeGroupRef.current = group;
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
    file?: FileMeta,
    // Runs once the message has an id but before it is stored/rendered -- used to
    // put the sender's own copy of a heavy file in the local cache first, so the
    // bubble doesn't go and download the file that was just uploaded.
    beforeStore?: (messageId: string) => Promise<void>
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
      const groupMessageId = localId ?? crypto.randomUUID();
      await beforeStore?.(groupMessageId);
      await appendMessage(session.userId, groupThreadKey(activeGroup.groupId), {
        id: groupMessageId,
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
    await beforeStore?.(ack.messageId);
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

  function stopTypingIfNeeded() {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    const target = typingTargetRef.current;
    if (target && socketRef.current) {
      sendTyping(socketRef.current, target, false);
    }
    typingTargetRef.current = null;
  }

  function handleDraftChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setDraft(value);

    const socket = socketRef.current;
    const target = activeGroup ? { groupId: activeGroup.groupId } : activePeer ? { recipientId: activePeer.peerId } : null;
    if (!socket || !target) return;

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    if (value.trim()) {
      // Only announce "started typing" once per burst of keystrokes — each
      // keystroke just refreshes the idle timeout below rather than
      // re-emitting the event.
      if (!typingTargetRef.current) {
        sendTyping(socket, target, true);
        typingTargetRef.current = target;
      }
      typingTimeoutRef.current = setTimeout(() => {
        sendTyping(socket, target, false);
        typingTargetRef.current = null;
      }, 3000);
    } else {
      stopTypingIfNeeded();
    }
  }

  // Label shown above the quoted snippet, from the replying user's point of
  // view: "You" for their own earlier message, otherwise the original sender.
  function replySenderLabelFor(m: LocalMessage): string {
    if (m.direction === "out") return "You";
    return m.senderUsername ?? activePeer?.peerUsername ?? "Unknown";
  }

  // Whose face goes on a voice note: mine for outgoing, otherwise the person
  // who sent it (a specific member in a group, the peer in a 1:1).
  function voiceAvatarFor(m: LocalMessage): { name: string; avatarUrl?: string | null } {
    if (m.direction === "out") return { name: session?.username ?? "", avatarUrl: session?.avatarUrl };
    if (activeGroup) {
      const member = activeGroup.members.find((x) => x.userId === m.senderId);
      return { name: member?.username ?? m.senderUsername ?? "?", avatarUrl: member?.avatarUrl };
    }
    return { name: activePeer?.peerUsername ?? "?", avatarUrl: activePeer?.peerAvatarUrl };
  }

  function buildReplyRef(m: LocalMessage): ReplyRef {
    return {
      messageId: m.id,
      senderLabel: replySenderLabelFor(m),
      preview: summarize(m.kind ?? "TEXT", m.viewOnce, m.body, m.file?.name),
    };
  }

  // Stable across renders (useCallback) so MessageBubble's memoization
  // below actually works — otherwise a fresh function reference on every
  // render (e.g. from a typing-indicator update, or the composer's own
  // per-keystroke state change) would force every bubble in the thread to
  // re-render regardless, which is what made typing feel laggy.
  const handleViewImage = useCallback((message: LocalMessage) => setViewerMessage(message), []);
  const closeImageViewer = useCallback(() => setViewerMessage(null), []);

  const handleReplyToMessage = useCallback((message: LocalMessage) => {
    setReplyingTo(message);
    composerInputRef.current?.focus();
  }, []);

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!session) return;
      const threadKey = activeGroup ? groupThreadKey(activeGroup.groupId) : activePeer?.peerId;
      if (!threadKey) return;

      await deleteMessage(session.userId, threadKey, messageId);
      // Also drop the local copy of a heavy file that belonged to it.
      await deleteCachedFile(session.userId, messageId);
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
    },
    [session, activeGroup, activePeer, refreshGroups, refreshConversations]
  );

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    stopTypingIfNeeded();
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

  function readFileAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
  }

  async function handleFileSelected(file: File) {
    setSending(true);
    setFileTransfer(null);
    const meta: FileMeta = { name: file.name, mime: file.type || "application/octet-stream", size: file.size };
    try {
      const replyRef = replyingTo ? buildReplyRef(replyingTo) : undefined;

      if (file.size <= INLINE_MAX_BYTES) {
        // Small enough to travel inside the message itself.
        await sendToActiveThread(await readFileAsDataUrl(file), "FILE", replyRef, meta);
      } else {
        // Heavy file: encrypt + upload in chunks over HTTP, then send only a
        // small pointer (and the key) through the Signal-encrypted message.
        const controller = new AbortController();
        fileUploadAbortRef.current = controller;
        setFileTransfer({ name: file.name, progress: 0 });
        const att = await uploadAttachment(
          file,
          (progress) => setFileTransfer({ name: file.name, progress }),
          controller.signal
        );
        await sendToActiveThread("", "FILE", replyRef, { ...meta, att }, async (messageId) => {
          if (session) await cacheFile(session.userId, messageId, file);
        });
        setFileTransfer(null);
      }
      setReplyingTo(null);
    } catch (err) {
      console.error(err);
      if (err instanceof AttachmentError && err.code === "cancelled") {
        setFileTransfer(null);
      } else {
        setFileTransfer({
          name: file.name,
          progress: 0,
          error: err instanceof Error && err.message ? err.message : "Couldn't send the file. Please try again.",
        });
      }
    } finally {
      fileUploadAbortRef.current = null;
      setSending(false);
    }
  }

  const handleOpenViewOnce = useCallback(
    async (messageId: string) => {
      if (!session || !activePeer || !socketRef.current) return;
      await markViewOnceOpened(session.userId, activePeer.peerId, messageId);
      await sendViewed(socketRef.current, messageId);
    },
    [session, activePeer]
  );

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
    if (direction === "outgoing" && !wasConnected && !callInviteSentRef.current) return;
    const isVideo = callVideoRef.current;
    const icon = isVideo ? "🎥" : "📞";
    let body: string;
    if (wasConnected) {
      body = `${icon} ${isVideo ? "Video" : "Voice"} call · ${formatCallDuration(callDurationRef.current)}`;
    } else if (direction === "outgoing") {
      body = `${icon} No answer`;
    } else {
      body = `${icon} Missed ${isVideo ? "video" : "voice"} call`;
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

  // The remote track is negotiated -- start playing it. This fires before any
  // audio can actually flow, so it deliberately does NOT flip the screen to
  // "connected"; that waits for the peer connection itself (handleCallConnected).
  function attachRemoteStream(stream: MediaStream) {
    setCallRemoteStream(stream);
    const audioEl = remoteAudioRef.current;
    // ontrack fires once per track (twice on a video call) with the same
    // stream -- re-assigning it would restart playback and abort the first play().
    if (audioEl && audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
      audioEl.play().catch((err) => {
        // Autoplay-with-sound is often blocked this soon after a user
        // gesture (accepting/placing the call) — surface a one-tap unlock
        // instead of silently leaving the call audible-but-silent. An
        // AbortError is just a newer load superseding this one, not a block.
        if (err?.name === "NotAllowedError") setCallNeedsAudioUnlock(true);
      });
    }
    // Safety net: if the WebView never reports the connection as up even
    // though the track arrived, don't sit on "Connecting…" forever.
    if (callConnectFallbackRef.current) clearTimeout(callConnectFallbackRef.current);
    callConnectFallbackRef.current = setTimeout(handleCallConnected, 8000);
  }

  // The audio connection is really up: stop ringing, start the clock.
  function handleCallConnected() {
    if (callConnectedRef.current || !callIdRef.current) return;
    callConnectedRef.current = true;
    if (callConnectFallbackRef.current) {
      clearTimeout(callConnectFallbackRef.current);
      callConnectFallbackRef.current = null;
    }
    callRingtoneRef.current?.stop();
    if (callRingTimeoutRef.current) {
      clearTimeout(callRingTimeoutRef.current);
      callRingTimeoutRef.current = null;
    }
    setCallConnecting(false);
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
    pendingIceCandidatesRef.current = [];
    callConnectedRef.current = false;
    if (callConnectFallbackRef.current) clearTimeout(callConnectFallbackRef.current);
    callConnectFallbackRef.current = null;
    if (callDisconnectTimeoutRef.current) clearTimeout(callDisconnectTimeoutRef.current);
    callDisconnectTimeoutRef.current = null;
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    callTimerRef.current = null;
    if (callRingTimeoutRef.current) clearTimeout(callRingTimeoutRef.current);
    callRingTimeoutRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setCallStatus(null);
    setCallPeer(null);
    setCallDuration(0);
    setCallMuted(false);
    setCallPeerMuted(false);
    setCallSpeakerOn(true);
    setCallRinging(false);
    setCallConnecting(false);
    setCallMinimized(false);
    setCallNeedsAudioUnlock(false);
    callVideoRef.current = false;
    setCallVideo(false);
    setCallLocalStream(null);
    setCallRemoteStream(null);
    setCallCameraOn(false);
    setCallPeerCameraOn(false);
    setCallCanSendVideo(false);
    setCallFacing("user");
    setCallReactions([]);
    setCallReconnecting(false);
    setCallWeak(false);
    setCallMyVideoPaused(false);
    setCallPeerVideoPaused(false);
  }

  // Used for both "the other side hung up/declined/failed" and "something
  // broke locally" — either way the call is over, so show why for a moment
  // and then tear the whole thing down.
  function failCall(message: string) {
    callRingtoneRef.current?.stop();
    setCallMinimized(false);
    setCallError(message);
    if (callErrorTimeoutRef.current) clearTimeout(callErrorTimeoutRef.current);
    // Long instructions (e.g. how to unblock the camera) need longer to read.
    const readMs = Math.min(6000, Math.max(2500, message.length * 60));
    callErrorTimeoutRef.current = setTimeout(() => {
      resetCallState();
      setCallError(null);
    }, readMs);
  }

  function makeCallClient(socket: Socket, peerUserId: string, callId: string, video: boolean): CallClient {
    return new CallClient(
      socket,
      peerUserId,
      callId,
      {
        onRemoteStream: attachRemoteStream,
        onFailure: failCall,
        onConnected: handleCallConnected,
        onLocalStream: setCallLocalStream,
        onConnectionChange: (state) => setCallReconnecting(state === "reconnecting"),
        onQuality: ({ weak }) => setCallWeak(weak),
        onVideoPaused: (paused) => {
          setCallMyVideoPaused(paused);
          // Tell the other side why my picture stopped (and when it's back) --
          // but not if I'd turned the camera off myself.
          const client = callClientRef.current;
          const target = callPeerRef.current;
          if (client?.isCameraOn && target && callIdRef.current && socketRef.current) {
            socketRef.current.emit("call:camera", { toUserId: target.userId, callId: callIdRef.current, on: !paused, paused });
          }
        },
      },
      video
    );
  }

  // Pulls the camera state out of the engine once local media is acquired.
  function syncCameraState(client: CallClient) {
    setCallCanSendVideo(client.canSendVideo);
    setCallCameraOn(client.isCameraOn);
    setCallFacing(client.cameraFacing);
  }

  async function startCall(peer: Conversation, video = false) {
    if (!socketRef.current || callIdRef.current) return;
    const socket = socketRef.current;
    const callId = crypto.randomUUID();
    callIdRef.current = callId;
    callDirectionRef.current = "outgoing";
    callVideoRef.current = video;
    callInviteSentRef.current = false;
    setCallVideo(video);
    setCallPeerCameraOn(video);
    setCallPeer({ userId: peer.peerId, username: peer.peerUsername, avatarUrl: peer.peerAvatarUrl });
    setCallError(null);
    setCallStatus("outgoing");

    const client = makeCallClient(socket, peer.peerId, callId, video);
    callClientRef.current = client;

    try {
      // Must finish before the mic is grabbed below — switching Android's
      // audio mode while an AudioRecord session is starting up can reset
      // it mid-capture, which was cancelling outgoing calls before they
      // even connected.
      await startCallAudioRouting();
      const offer = await client.startAsCaller();
      // The call may have been cancelled locally while we were still
      // waiting on mic permission above — don't resurrect it by inviting
      // the other side to a call we've already torn down.
      if (callIdRef.current !== callId) return;
      syncCameraState(client);
      const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        socket.emit("call:invite", { toUserId: peer.peerId, callId, sdp: offer, video }, resolve);
      });
      if (callIdRef.current !== callId) return;
      if (!ack.ok) {
        failCall(ack.error ?? "Couldn't place the call.");
        return;
      }
      callInviteSentRef.current = true;
      setCallRinging(true);
      if (!callRingtoneRef.current) callRingtoneRef.current = new RingtonePlayer();
      callRingtoneRef.current.start("outgoing");
      callRingTimeoutRef.current = setTimeout(() => {
        socket.emit("call:end", { toUserId: peer.peerId, callId });
        failCall("No answer.");
      }, 30000);
    } catch (err) {
      // Hung up while the permission prompt was still open: the call is
      // already gone (and a newer one may be in progress), so leave it alone.
      if (callIdRef.current !== callId) return;
      failCall(err instanceof Error ? err.message : video ? "Couldn't access your camera or microphone." : "Couldn't access your microphone.");
    }
  }

  async function handleAcceptCall() {
    if (!socketRef.current || !callPeer || !callIdRef.current || !pendingOfferRef.current) return;
    callRingtoneRef.current?.stop();
    setCallConnecting(true);
    const socket = socketRef.current;
    const peerUserId = callPeer.userId;
    const callId = callIdRef.current;
    const offer = pendingOfferRef.current;

    const client = makeCallClient(socket, peerUserId, callId, callVideoRef.current);
    callClientRef.current = client;

    // Flush anything that arrived while we were still ringing — see the
    // call:ice handler above. addRemoteIceCandidate queues internally if
    // the remote description isn't set yet, so this is safe to do before
    // acceptAsCallee below.
    const buffered = pendingIceCandidatesRef.current;
    pendingIceCandidatesRef.current = [];
    for (const candidate of buffered) {
      client.addRemoteIceCandidate(candidate);
    }

    try {
      // Also awaited here (not just on the "incoming" event) as a safety
      // net in case accept is tapped fast enough to race the mode switch —
      // it's a no-op on the native side if routing is already active.
      await startCallAudioRouting();
      const answer = await client.acceptAsCallee(offer);
      pendingOfferRef.current = null;
      syncCameraState(client);
      socket.emit("call:answer", { toUserId: peerUserId, callId, sdp: answer });
      // No usable camera on this side: take the call anyway and let the
      // caller know to show an avatar rather than waiting on a video feed.
      if (callVideoRef.current && !client.isCameraOn) {
        socket.emit("call:camera", { toUserId: peerUserId, callId, on: false });
      }
    } catch (err) {
      if (callIdRef.current !== callId) return;
      failCall(err instanceof Error ? err.message : "Couldn't access your microphone.");
    }
  }

  function handleDeclineCall() {
    if (socketRef.current && callPeer && callIdRef.current) {
      // Once the callee has tapped Accept the call is theirs to end, not reject.
      const event = callStatus === "incoming" && !callConnecting ? "call:reject" : "call:end";
      socketRef.current.emit(event, { toUserId: callPeer.userId, callId: callIdRef.current });
    }
    resetCallState();
  }

  function toggleCallMute() {
    const next = !callMuted;
    callClientRef.current?.setMuted(next);
    setCallMuted(next);
    // Let the other side show its "muted" indicator.
    if (socketRef.current && callPeer && callIdRef.current) {
      socketRef.current.emit("call:mute", { toUserId: callPeer.userId, callId: callIdRef.current, muted: next });
    }
  }

  function toggleCallSpeaker() {
    const next = !callSpeakerOn;
    setCallSpeakerOn(next);
    setCallSpeaker(next);
  }

  async function toggleCallCamera() {
    const client = callClientRef.current;
    if (!client?.canSendVideo) return;
    const next = !client.isCameraOn;
    try {
      await client.setCameraEnabled(next);
    } catch {
      // Camera couldn't be reopened (taken by another app, permission revoked).
      setCallCameraOn(client.isCameraOn);
      return;
    }
    setCallCameraOn(client.isCameraOn);
    if (socketRef.current && callPeer && callIdRef.current) {
      socketRef.current.emit("call:camera", { toUserId: callPeer.userId, callId: callIdRef.current, on: client.isCameraOn });
    }
  }

  async function switchCallCamera() {
    const client = callClientRef.current;
    if (!client?.canSendVideo) return;
    try {
      const facing = await client.switchCamera();
      if (facing) setCallFacing(facing);
    } catch {
      // Keep whatever camera state we had.
    }
    setCallCameraOn(client.isCameraOn);
  }

  // Floats an emoji up the screen for a few seconds. Used for both my own taps
  // (shown immediately, not waiting on a round trip) and the peer's.
  function pushCallReaction(emoji: string, name: string, mine: boolean) {
    const reaction: CallReaction = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      emoji,
      name: mine ? "You" : name,
      left: 8 + Math.random() * 70,
      sway: Math.random() * 60 - 30,
    };
    setCallReactions((prev) => [...prev.slice(-24), reaction]);
    setTimeout(() => setCallReactions((prev) => prev.filter((r) => r.id !== reaction.id)), CALL_REACTION_LIFETIME_MS);
  }

  function sendCallReaction(emoji: string) {
    const now = Date.now();
    // A held-down or hammered emoji button shouldn't flood the other screen.
    if (now - lastReactionSentRef.current < 250) return;
    lastReactionSentRef.current = now;
    pushCallReaction(emoji, "", true);
    if (socketRef.current && callPeer && callIdRef.current) {
      socketRef.current.emit("call:reaction", { toUserId: callPeer.userId, callId: callIdRef.current, emoji });
    }
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
    <div className={`chat-shell ${activePeer || activeGroup ? "has-active-thread" : ""} ${callStatus && callMinimized ? "call-minimized" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand-bar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sidebar-brand-logo" src="/logo/matrix-chat-mark.svg" alt="" aria-hidden="true" />
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
            threadViews.map((t) => {
              const typingUsers = typingByThread[t.key];
              const isTyping = !!typingUsers?.length;
              return (
              <div
                key={t.key}
                className={`conversation-item ${activeKey === t.key ? "active" : ""}`}
                onClick={() => handleSelectThread(t)}
              >
                <Avatar name={t.name} avatarUrl={t.avatarUrl} size={44} online={!t.isGroup ? presenceByUserId[t.key]?.online : undefined} />
                <span className="conversation-text">
                  <span className="peer">
                    {t.isGroup && "👥 "}
                    {t.name}
                  </span>
                  {isTyping ? (
                    <span className="preview preview-typing">
                      {t.isGroup ? `${typingUsers.join(", ")} typing...` : "typing..."}
                    </span>
                  ) : (
                    <span className="preview">{t.lastMessage || "No messages yet"}</span>
                  )}
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
              );
            })
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
                  online={!activeGroup && activePeer ? presenceByUserId[activePeer.peerId]?.online : undefined}
                />
                <span className="chat-header-text">
                  <span className="chat-header-name">{activeGroup ? activeGroup.name : activePeer!.peerUsername}</span>
                  <span className="lock">
                    {(() => {
                      const typingUsers = typingByThread[activeKey ?? ""];
                      if (typingUsers?.length) {
                        return activeGroup ? `${typingUsers.join(", ")} typing...` : "typing...";
                      }
                      if (activeGroup) return `${activeGroup.members.length} members`;
                      return peerStatusLine(activePeer ? presenceByUserId[activePeer.peerId] : undefined);
                    })()}
                  </span>
                </span>
              </div>
              <div className="chat-header-actions">
                {!activeGroup && (
                  <button
                    type="button"
                    className="chat-info-btn"
                    onClick={() => activePeer && startCall(activePeer, false)}
                    disabled={!!callStatus}
                    aria-label="Voice call"
                    title="Voice call"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                      <path d="M6.6 10.8c1.4 2.8 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1L6.6 10.8z" />
                    </svg>
                  </button>
                )}
                {!activeGroup && (
                  <button
                    type="button"
                    className="chat-info-btn"
                    onClick={() => activePeer && startCall(activePeer, true)}
                    disabled={!!callStatus}
                    aria-label="Video call"
                    title="Video call"
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                      <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
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
              {messages.map((m) => {
                const avatar = voiceAvatarFor(m);
                return (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    onOpenViewOnce={handleOpenViewOnce}
                    showSender={!!activeGroup}
                    onReply={handleReplyToMessage}
                    onDelete={handleDeleteMessage}
                    onViewImage={handleViewImage}
                    avatarName={avatar.name}
                    avatarUrl={avatar.avatarUrl}
                  />
                );
              })}
            </div>
            {fileTransfer && (
              <div className={`transfer-strip ${fileTransfer.error ? "transfer-strip-error" : ""}`} role="status">
                <div className="transfer-strip-text">
                  <span className="transfer-strip-name">{fileTransfer.name}</span>
                  {fileTransfer.error ? (
                    <span className="transfer-strip-detail">{fileTransfer.error}</span>
                  ) : (
                    <span className="transfer-strip-detail">Encrypting and uploading… {Math.round(fileTransfer.progress * 100)}%</span>
                  )}
                  {!fileTransfer.error && (
                    <span className="transfer-strip-bar">
                      <span className="transfer-strip-fill" style={{ width: `${Math.round(fileTransfer.progress * 100)}%` }} />
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="reply-preview-close"
                  onClick={() => {
                    fileUploadAbortRef.current?.abort();
                    setFileTransfer(null);
                  }}
                  aria-label={fileTransfer.error ? "Dismiss" : "Cancel upload"}
                >
                  ✕
                </button>
              </div>
            )}
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
                      onChange={handleDraftChange}
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
              status={
                activeGroup
                  ? `${activeGroup.members.length} members`
                  : peerStatusLine(activePeer ? presenceByUserId[activePeer.peerId] : undefined)
              }
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
          peerMuted={callPeerMuted}
          speakerOn={callSpeakerOn}
          showSpeaker={Capacitor.isNativePlatform()}
          ringing={callRinging}
          connecting={callConnecting}
          minimized={callMinimized}
          error={callError}
          needsAudioUnlock={callNeedsAudioUnlock}
          video={callVideo}
          localStream={callLocalStream}
          remoteStream={callRemoteStream}
          cameraOn={callCameraOn}
          peerCameraOn={callPeerCameraOn}
          canSendVideo={callCanSendVideo}
          facing={callFacing}
          reactions={callReactions}
          reconnecting={callReconnecting}
          weakConnection={callWeak}
          myVideoPaused={callMyVideoPaused}
          peerVideoPaused={callPeerVideoPaused}
          onToggleCamera={toggleCallCamera}
          onSwitchCamera={switchCallCamera}
          onReact={sendCallReaction}
          onAccept={handleAcceptCall}
          onDecline={handleDeclineCall}
          onToggleMute={toggleCallMute}
          onToggleSpeaker={toggleCallSpeaker}
          onMinimize={() => setCallMinimized(true)}
          onRestore={() => setCallMinimized(false)}
          onUnlockAudio={handleUnlockCallAudio}
        />
      )}
      {viewerMessage?.file && (
        <ImageViewer src={viewerMessage.body} name={viewerMessage.file.name} size={viewerMessage.file.size} onClose={closeImageViewer} />
      )}
      <audio ref={remoteAudioRef} autoPlay hidden />
      {showExitPrompt && <div className="exit-prompt-toast">Press back again to exit</div>}
    </div>
  );
}

// WhatsApp-style relative "last seen" phrasing: recent times read as a
// duration, older ones fall back to a clock time (today) or a date.
function formatLastSeen(iso: string): string {
  const then = new Date(iso);
  const diffMs = Date.now() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "last seen just now";
  if (diffMin < 60) return `last seen ${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `last seen ${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;

  const clock = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayDiff = Math.round((startOfToday.getTime() - startOfThen.getTime()) / 86_400_000);
  if (dayDiff === 1) return `last seen yesterday at ${clock}`;
  if (dayDiff < 7) return `last seen ${then.toLocaleDateString([], { weekday: "long" })} at ${clock}`;
  return `last seen ${then.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })}`;
}

// The header subtitle / contact-details status line for a 1:1 chat: typing
// (handled by the caller, which knows the thread key) takes priority over
// this, which is "online" > "last seen ..." > the encryption note once
// nothing about presence is known yet.
function peerStatusLine(presence: PresenceInfo | undefined): string {
  if (presence?.online) return "online";
  if (presence?.lastSeenAt) return formatLastSeen(presence.lastSeenAt);
  return "🔒 End-to-end encrypted";
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
