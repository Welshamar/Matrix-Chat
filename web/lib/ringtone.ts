// Synthesized with Web Audio API rather than an audio file asset — a
// two-tone beep repeated on an interval, loud enough to notice but not
// harsh. "outgoing" (ringback, heard while calling) uses a lower tone than
// "incoming" (heard while being called) so the two are distinguishable.
export type RingtoneKind = "outgoing" | "incoming";

export class RingtonePlayer {
  private ctx: AudioContext | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(kind: RingtoneKind): void {
    this.stop();
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioContextCtor();

    const frequencies = kind === "incoming" ? [480, 620] : [425, 425];
    const playBeep = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      const now = ctx.currentTime;
      frequencies.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
        gain.gain.linearRampToValueAtTime(0, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.4);
        osc.stop(now + i * 0.4 + 0.35);
      });
    };

    playBeep();
    this.intervalId = setInterval(playBeep, 2200);
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
