import { spawn } from 'node:child_process';

/**
 * Run a helper process, stream newline-delimited stdout lines to `onLine`,
 * enforce a timeout and honour an AbortSignal. Resolves with exit details;
 * never rejects for non-zero exit codes (callers interpret the output).
 */
export function runProcess(command, args, { timeoutMs = 60_000, signal, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const lines = [];

    const kill = () => {
      if (child.exitCode !== null) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        lines.push(line);
        onLine?.(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { if (stderr.length < 8192) stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (buffer.trim()) { lines.push(buffer.trim()); onLine?.(buffer.trim()); }
      resolve({ code, stderr, lines, timedOut, aborted });
    });
  });
}
