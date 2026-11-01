/* Visibility-aware polling. Legacy behaviour: poll every 8 s, pause while the
   tab is hidden, and fetch immediately when it becomes visible again. The
   dependencies are injected so the schedule is testable without a browser. */

export interface PollDeps {
  isVisible: () => boolean;
  onVisibleChange: (listener: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

function browserDeps(): PollDeps {
  return {
    isVisible: () => document.visibilityState !== 'hidden',
    onVisibleChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

/**
 * Run `task` on an interval while the tab is visible, and once immediately when
 * the tab returns to the foreground. Returns a stop function.
 */
export function attachVisibilityPoll(intervalMs: number, task: () => void, deps: PollDeps = browserDeps()): () => void {
  const tick = (): void => {
    if (deps.isVisible()) task();
  };
  const handle = deps.setInterval(tick, intervalMs);
  const detach = deps.onVisibleChange(() => {
    if (deps.isVisible()) task();
  });
  return () => {
    deps.clearInterval(handle);
    detach();
  };
}
