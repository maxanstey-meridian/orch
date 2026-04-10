export type InterruptState = {
  readonly skipRequested: () => boolean;
  readonly quitRequested: () => boolean;
  readonly hardInterrupt: () => string | null;
  readonly clearHardInterrupt: () => void;
  readonly toggleSkip: () => boolean;
  readonly requestQuit: () => void;
  readonly setHardInterrupt: (guidance: string) => void;
};

export const createInterruptState = (): InterruptState => {
  let skipFlag = false;
  let quitFlag = false;
  let hardInterruptGuidance: string | null = null;

  return {
    skipRequested: () => skipFlag,
    quitRequested: () => quitFlag,
    hardInterrupt: () => hardInterruptGuidance,
    clearHardInterrupt: () => {
      hardInterruptGuidance = null;
    },
    toggleSkip: () => {
      skipFlag = !skipFlag;
      return skipFlag;
    },
    requestQuit: () => {
      quitFlag = true;
    },
    setHardInterrupt: (guidance: string) => {
      hardInterruptGuidance = guidance;
    },
  };
};
