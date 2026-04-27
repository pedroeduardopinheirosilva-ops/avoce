/**
 * In-memory cron run tracker.
 * Records timestamps each time a cron function completes.
 * Resets on PM2 restart — that's fine, health checks will show nulls until the next run.
 */

const _lastRun = new Map<string, Date>();
const OVERDUE_MS = 30 * 60 * 1000; // 30 min

export function recordCronRun(name: string): void {
  _lastRun.set(name, new Date());
}

export function getCronLastRun(name: string): Date | null {
  return _lastRun.get(name) ?? null;
}

export function getCronHealthSnapshot(): {
  last_run_processarTimeoutsAgente: string | null;
  last_run_recuperarMensagensPerdidas: string | null;
  last_run_processarHandoffsAtrasados: string | null;
  any_overdue: boolean;
} {
  const now = Date.now();
  const iso = (name: string) => _lastRun.get(name)?.toISOString() ?? null;

  const tracked = [
    "processarTimeoutsAgente",
    "recuperarMensagensPerdidas",
    "processarHandoffsAtrasados",
  ];

  const any_overdue = tracked.some(name => {
    const last = _lastRun.get(name);
    if (!last) return false; // not yet run — don't flag as overdue on fresh restart
    return now - last.getTime() > OVERDUE_MS;
  });

  return {
    last_run_processarTimeoutsAgente: iso("processarTimeoutsAgente"),
    last_run_recuperarMensagensPerdidas: iso("recuperarMensagensPerdidas"),
    last_run_processarHandoffsAtrasados: iso("processarHandoffsAtrasados"),
    any_overdue,
  };
}
