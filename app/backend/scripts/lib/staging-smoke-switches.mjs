// Switch restoration and step deadlines for scripts/staging-e2e-smoke.mjs (pure, injectable).

/**
 * Runs `journey` after turning ON the keys that were OFF; ALWAYS turns those same keys OFF
 * again afterwards (failure, timeout or abort included). Keys already ON are never touched.
 * Returns { failure, restoreFailures } instead of throwing, so the caller decides the exit code.
 */
export async function runWithSwitches({ keys, getStates, setSwitch, journey }) {
  const turnedOn = [];
  const restoreFailures = [];
  let failure = null;
  try {
    const states = await getStates();
    for (const key of keys) {
      if (states[key] === true) continue;
      turnedOn.push(key); // registered before the call: a half-applied change is still restored
      await setSwitch(key, true);
    }
    await journey({ alreadyOn: keys.filter((k) => states[k] === true) });
  } catch (error) {
    failure = error;
  } finally {
    for (const key of [...turnedOn].reverse()) {
      try {
        await setSwitch(key, false);
      } catch {
        restoreFailures.push(key);
      }
    }
  }
  return { failure, restoreFailures };
}

/** Rejects with makeError() after ms and calls onTimeout() first (used to abort in-flight work). */
export async function withDeadline(fn, ms, makeError, onTimeout) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(makeError());
    }, ms);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
