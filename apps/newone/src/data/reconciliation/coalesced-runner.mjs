/**
 * Serialize an asynchronous reconciliation task and collapse any number of
 * invalidations received while it is running into one follow-up pass.
 *
 * @param {() => Promise<void>} task
 */
export function createCoalescedRunner(task) {
  let inFlight = null;
  let runAgain = false;
  let disposed = false;

  const run = () => {
    if (disposed) return Promise.resolve();
    if (inFlight) {
      runAgain = true;
      return inFlight;
    }

    const tracked = Promise.resolve()
      .then(async () => {
        do {
          runAgain = false;
          await task();
        } while (runAgain && !disposed);
      })
      .finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
    inFlight = tracked;
    return tracked;
  };

  return {
    run,
    isRunning() {
      return inFlight !== null;
    },
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      runAgain = false;
    },
  };
}
