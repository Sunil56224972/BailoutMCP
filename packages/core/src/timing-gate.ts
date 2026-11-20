import type { BailoutConfig, TimingGateStatus } from './types.js';

/**
 * Anti-Annoyance Interruption Timing Gate ("Zero-Clippy" guard).
 *
 * Ensures a silently pre-solved heavy-model bailout NEVER interrupts the
 * developer mid-keystroke. It waits for a natural micro-pause after friction
 * (e.g., >= 3.5s idle following a failed save/undo/error) before allowing an
 * unsolicited toast/notification to surface.
 */
export class TimingGate {
  private lastActivityAt = 0;
  private recentEditTimestamps: number[] = [];
  private config: BailoutConfig;

  constructor(config: BailoutConfig) {
    this.config = config;
  }

  updateConfig(config: BailoutConfig): void {
    this.config = config;
  }

  recordActivity(now = Date.now(), isEdit = false): void {
    this.lastActivityAt = Math.max(this.lastActivityAt, now);
    if (isEdit) {
      this.recentEditTimestamps.push(now);
      this.recentEditTimestamps = this.recentEditTimestamps.filter((ts) => now - ts <= 5000);
    }
  }

  evaluate(now = Date.now(), cooldownUntil = 0): TimingGateStatus {
    this.recentEditTimestamps = this.recentEditTimestamps.filter((ts) => now - ts <= 5000);
    const editsInLast5s = this.recentEditTimestamps.length;
    const idleMs = this.lastActivityAt > 0 ? Math.max(0, now - this.lastActivityAt) : this.config.pauseGateMs;

    if (now < cooldownUntil) {
      const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
      return {
        canSurfaceNow: false,
        idleMs,
        pauseGateMs: this.config.pauseGateMs,
        editsInLast5s,
        reason: `Cooldown active (${remainingSec}s remaining)`,
      };
    }

    if (idleMs < this.config.pauseGateMs) {
      return {
        canSurfaceNow: false,
        idleMs,
        pauseGateMs: this.config.pauseGateMs,
        editsInLast5s,
        reason: `User actively typing/editing (${idleMs}ms < ${this.config.pauseGateMs}ms pause gate)`,
      };
    }

    if (editsInLast5s >= 3 && idleMs < this.config.pauseGateMs * 1.5) {
      return {
        canSurfaceNow: false,
        idleMs,
        pauseGateMs: this.config.pauseGateMs,
        editsInLast5s,
        reason: `Recent rapid edit burst (${editsInLast5s} edits in 5s); waiting for clean pause`,
      };
    }

    if (this.lastActivityAt > 0 && idleMs > this.config.maxAutoSurfaceIdleMs) {
      return {
        canSurfaceNow: false,
        idleMs,
        pauseGateMs: this.config.pauseGateMs,
        editsInLast5s,
        reason: `User appears away (${Math.round(idleMs / 1000)}s idle); keeping silent in status pill`,
      };
    }

    return {
      canSurfaceNow: true,
      idleMs,
      pauseGateMs: this.config.pauseGateMs,
      editsInLast5s,
      reason: `Natural micro-pause detected (${idleMs}ms idle) — safe to offer bailout`,
    };
  }
}
