// Short one-shot blips for sending/receiving a message — synthesized like
// the ringtone (no audio asset needed), each call opens and closes its own
// AudioContext since these fire once and are gone, unlike the looping
// RingtonePlayer. "Sent" is a quick upward blip; "received" is a slightly
// lower two-note pop, deliberately different so the two are distinguishable
// without looking at the screen.
function playTone(notes: { freq: number; start: number; length: number }[]) {
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioContextCtor();
  const now = ctx.currentTime;
  let latestEnd = 0;

  notes.forEach(({ freq, start, length }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.14, now + start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + length);
    latestEnd = Math.max(latestEnd, start + length);
  });

  setTimeout(() => ctx.close().catch(() => {}), (latestEnd + 0.1) * 1000);
}

export function playSentTone(): void {
  try {
    playTone([
      { freq: 700, start: 0, length: 0.09 },
      { freq: 1000, start: 0.06, length: 0.12 },
    ]);
  } catch {
    // Best-effort — never let a sound glitch block sending a message.
  }
}

export function playReceivedTone(): void {
  try {
    playTone([
      { freq: 880, start: 0, length: 0.11 },
      { freq: 660, start: 0.09, length: 0.16 },
    ]);
  } catch {
    // Best-effort — never let a sound glitch break message handling.
  }
}
