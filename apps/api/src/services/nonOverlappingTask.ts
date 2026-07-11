export type NonOverlappingTaskResult<T> =
  | { started: false }
  | { started: true; value: T };

export function createNonOverlappingTask<T>(task: () => Promise<T>) {
  let running = false;
  let stopped = false;

  return {
    async run(): Promise<NonOverlappingTaskResult<T>> {
      if (running || stopped) return { started: false };
      running = true;
      try {
        return { started: true, value: await task() };
      } finally {
        running = false;
      }
    },
    stop() {
      stopped = true;
    },
    isStopped() {
      return stopped;
    }
  };
}
