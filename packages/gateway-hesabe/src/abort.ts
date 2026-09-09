export function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/** A timeout still settles when an injected transport ignores AbortSignal. */
export async function awaitWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  reason: () => Error = abortError,
): Promise<T> {
  // The operation may outlive its caller; always observe its eventual rejection.
  void pending.catch(() => undefined);
  if (!signal) return pending;
  if (signal.aborted) throw reason();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>;
  const delay = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, delayMs);
  });
  try {
    await awaitWithAbort(delay, signal);
  } finally {
    clearTimeout(timer);
  }
}
