// Default jest boundary for expo-audio. The native module cannot initialize
// inside jest-expo, so every suite receives this inert implementation unless a
// test overrides the boundary with an explicit jest.mock('expo-audio', ...).

export const AudioModule = {
  requestRecordingPermissionsAsync: async () => ({ granted: false }),
};

export const RecordingPresets = {
  HIGH_QUALITY: { extension: '.m4a' },
  LOW_QUALITY: { extension: '.m4a' },
};

export async function setAudioModeAsync() {
  return undefined;
}

export function useAudioRecorder() {
  return {
    uri: null as string | null,
    isRecording: false,
    prepareToRecordAsync: async () => undefined,
    record: () => undefined,
    stop: async () => undefined,
  };
}

export function useAudioPlayer() {
  return {
    playing: false,
    play: () => undefined,
    pause: () => undefined,
    seekTo: async () => undefined,
  };
}

export function useAudioPlayerStatus() {
  return { playing: false, currentTime: 0, duration: 0, isLoaded: false };
}
