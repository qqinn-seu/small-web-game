export type AudioCue = 'stone' | 'turn' | 'win' | 'lose' | 'brush';

export interface GameAudioState {
  muted: boolean;
  unlocked: boolean;
  supported: boolean;
  played: Record<AudioCue, number>;
}
