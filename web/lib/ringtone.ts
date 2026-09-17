// Synthesized with Web Audio API rather than an audio file asset — a short
// melodic phrase repeated on an interval. "incoming" (being called) is a
// bright ascending chime; "outgoing" (ringback, heard while calling) is a
// softer descending phrase, so the two are clearly distinguishable by ear.
export type RingtoneKind = "outgoing" | "incoming";

const INCOMING_NOTES = [523.25, 659.25, 784.0]; // C5, E5, G5 — bright, ascending
const OUTGOING_NOTES = [392.0, 329.63]; // G4, E4 — softer, descending

export class RingtonePlayer {
  private ctx: AudioContext | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(kind: RingtoneKind): void {
    this.stop();
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioContextCtor();

    const notes = kind === "incoming" ? INCOMING_NOTES : OUTGOING_NOTES;
    const noteGap = 0.16;
    const noteLength = 0.5;

    const playPhrase = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      const now = ctx.currentTime;
      notes.forEach((freq, i) => {
        const start = now + i * noteGap;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.1, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + noteLength);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + noteLength);
      });
    };

    playPhrase();
    this.intervalId = setInterval(playPhrase, 2600);
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
