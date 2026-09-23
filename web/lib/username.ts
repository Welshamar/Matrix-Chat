// Username rules, shared by the register form (instant feedback) and mirrored
// server-side in server/src/controllers/auth.controller.ts (the actual
// enforcement point -- this client copy exists only for a fast inline error).
//
// Deliberately permissive: any script's letters, spaces, and punctuation are
// fine (a username is just a display handle here, not an identifier used in
// URLs or filenames -- lookups already go through encodeURIComponent). The
// only things excluded are emoji (keeps it readable as plain text next to a
// message bubble, avatar, etc.) and control characters (would break layout
// or hide content). Leading/trailing whitespace is trimmed; internal spaces
// ("John Doe") are allowed.
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

// Extended_Pictographic covers the vast majority of emoji; Emoji_Modifier
// (skin tones) and Regional_Indicator (flag pairs, e.g. 🇺🇸) are separate
// Unicode properties not already covered by it.
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}/u;
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

export interface UsernameCheck {
  ok: boolean;
  error?: string;
}

export function checkUsername(raw: string): UsernameCheck {
  const trimmed = raw.trim();
  if (trimmed.length < USERNAME_MIN_LENGTH || trimmed.length > USERNAME_MAX_LENGTH) {
    return { ok: false, error: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters.` };
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return { ok: false, error: "Username can't contain control characters." };
  }
  if (EMOJI_PATTERN.test(trimmed)) {
    return { ok: false, error: "Username can't contain emoji." };
  }
  return { ok: true };
}
