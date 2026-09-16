import { useCallback, useEffect, useState } from 'react';

import { getConfig, getReport, startSession, stopSession } from './api.js';
import useSession from './hooks/useSession.js';
import Header from './components/Header.jsx';
import SessionBar from './components/SessionBar.jsx';
import IdlePane from './components/IdlePane.jsx';
import ListeningPane from './components/ListeningPane.jsx';
import ReportPane from './components/ReportPane.jsx';

export default function App() {
  const { session, refresh } = useSession();
  const [report, setReport] = useState(null);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);

  const status = session ? session.status : 'idle';

  // Config drives the custom-namespace transform. Loaded once — the backend
  // reads semconv-checker.config.yaml at startup, so it does not change.
  useEffect(() => {
    getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  // Load the report whenever we enter the `report` state; clear it otherwise.
  useEffect(() => {
    let cancelled = false;
    if (status === 'report') {
      getReport().then((r) => {
        if (!cancelled) setReport(r);
      });
    } else {
      setReport(null);
    }
    return () => {
      cancelled = true;
    };
  }, [status]);

  const onStart = useCallback(async () => {
    setBusy(true);
    try {
      await startSession();
      await refresh();
    } catch {
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const onStop = useCallback(async () => {
    setBusy(true);
    try {
      await stopSession();
      await refresh();
    } catch {
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="page">
      <div className="app">
        <Header status={status} />
        <SessionBar session={session} busy={busy} onStart={onStart} onStop={onStop} />
        {status === 'listening' && <ListeningPane session={session} />}
        {status === 'report' && <ReportPane report={report} config={config} />}
        {status !== 'listening' && status !== 'report' && <IdlePane session={session} />}
      </div>
    </div>
  );
}
