import { AgentError } from '../errors.js';
import { runProcess } from './process.js';

/**
 * Run a Windows PowerShell 5.1 bridge script that prints newline-delimited
 * JSON events. Resolves with all events; throws mapped AgentErrors for
 * cancellation, timeout, {"type":"error"} events and abnormal exits.
 */
export async function runPowerShellBridge(script, args, { powershell = 'powershell.exe', timeoutMs = 60_000, signal, onEvent, mapError, label = 'scanner' } = {}) {
  const events = [];
  const res = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    timeoutMs,
    signal,
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      events.push(ev);
      onEvent?.(ev);
    },
  }).catch((e) => {
    throw new AgentError('ADAPTER_UNAVAILABLE', `Could not start the ${label} helper (powershell.exe).`, { reason: e.code });
  });
  if (res.aborted) throw new AgentError('SCAN_CANCELLED', 'Scan was cancelled.');
  if (res.timedOut) throw new AgentError('SCAN_TIMEOUT', 'The scanner did not respond in time.');
  const err = events.find((e) => e.type === 'error');
  if (err) throw mapError(err);
  if (res.code !== 0) throw new AgentError('DRIVER_ERROR', `${label} helper failed.`, { exitCode: res.code });
  return events;
}
