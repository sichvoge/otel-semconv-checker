import { useCallback, useEffect, useRef, useState } from 'react';

import { getSession } from '../api.js';

const POLL_MS = 2000;

// Tracks GET /api/session. Fetches once on mount and then polls every 2s while
// the session is `listening` (SPEC § Frontend / phase-3 plan). `refresh()`
// forces an immediate re-fetch — used right after start/stop so the UI does not
// wait for the next tick.
export default function useSession() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getSession();
      setSession(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const next = await refresh();
      const listening = next && next.status === 'listening';
      timer.current = setTimeout(tick, listening ? POLL_MS : POLL_MS * 2);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  return { session, error, refresh };
}
