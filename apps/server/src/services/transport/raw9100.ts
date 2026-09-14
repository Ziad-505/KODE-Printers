import { Socket } from 'node:net';
import { AppError } from '@kode/shared';
import { subsystem } from '../../utilities/logger.js';
import {
  frameDocument,
  getFramingOrder,
  guardRawContent,
  type FramingStrategy,
  type PjlOptions,
} from './pjl.js'

const log = subsystem('transport:raw9100');

/**
 * RAW/JetDirect printing — a plain TCP socket on port 9100 (§B6.4).
 *
 * There is no feedback channel. A successful send means the device's TCP stack
 * accepted the bytes, and nothing more: not that it printed, not that it
 * understood the PJL, not that it had paper. Every limitation of this transport
 * follows from that one fact, and it is why IPP is preferred wherever the
 * device supports it.
 *
 * INV-03 — this module and its IPP sibling are the only places in the codebase
 * that open a socket to a printer.
 */

export const RAW_PORT = 9100;

export interface RawSendOptions {
  host: string;
  port?: number;
  document: Buffer;
  contentType: string;
  pjl: PjlOptions;
  /** Framing to use. Omit to run the fallback ladder. */
  framing?: FramingStrategy;
  /** Vendor token (e.g. from IPP `printer-make-and-model`), used to order the ladder. */
  vendor?: string | null;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export interface RawSendResult {
  bytesWritten: number;
  framingUsed: FramingStrategy;
  durationMs: number;
}

/**
 * Writes a framed document to the device.
 *
 * The close sequence matters more than it looks. `end()` performs a half-close:
 * it flushes the payload and sends FIN, telling the device "that is the whole
 * job". Destroying the socket instead — or letting it drop when the process
 * moves on — leaves some firmware waiting for more data until an internal
 * timeout, at which point it may discard the job entirely or print a partial
 * page. Waiting for `close` after `end` is what makes "sent" mean the bytes
 * left the machine.
 */
export async function sendRaw(options: RawSendOptions): Promise<RawSendResult> {
  const guard = guardRawContent(options.document, options.contentType);
  if (!guard.safe) {
    // INV-09's sibling: no byte reaches the socket until this passes.
    throw new AppError('PJL_INJECTION_REJECTED', guard.reason ?? 'File rejected.', {
      details: { host: options.host },
      retryable: false,
    });
  }

    const ladder = options.framing ? [options.framing] : getFramingOrder(options.vendor);
  let lastError: unknown;

  for (const framing of ladder) {
    try {
      const payload = frameDocument(options.document, options.pjl, framing);
      const startedAt = Date.now();
      await writeToSocket({
        host: options.host,
        port: options.port ?? RAW_PORT,
        payload,
        connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
        writeTimeoutMs: options.writeTimeoutMs ?? 120_000,
      });
      return {
        bytesWritten: payload.length,
        framingUsed: framing,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error;

      // Anything that is not a reset — refused connection, timeout, unreachable
      // host — says nothing about the framing, so the ladder has nothing to
      // offer and the error stands.
      if (!isConnectionReset(error)) break;

      /* A reset advances the ladder. That is the whole reason §B6.4 specifies
       * one: a Xerox that dislikes an explicit LANGUAGE line rejects the block
       * by tearing down the connection, and the same block without it prints.
       *
       * The payload having reached the kernel does not mean the device kept it.
       * A guard here that refused to retry once the write completed sounded
       * careful and disabled the ladder outright: a job small enough to hand
       * over in one write — which is most of them — always looked "fully
       * written" by the time the reset landed, so the fallback never ran and
       * every device in the estate that needs it simply failed.
       *
       * RAW has no feedback channel, so the residual risk is real and stated
       * rather than designed away: a device that accepts a job and *then*
       * resets instead of closing cleanly gets the next framing too, and prints
       * twice. Weighed against a framing fallback that never fires, a rare
       * duplicate is the better failure — and it is logged either way. */
      const wroteFully = (error as NodeJS.ErrnoException & { writeCompleted?: boolean })
        .writeCompleted;
      log.warn(
        { host: options.host, framing, wroteFully: wroteFully === true },
        'device reset the connection; trying next framing',
      );
    }
  }

  throw new AppError('PRINTER_UNREACHABLE', 'The printer did not accept the job.', {
    details: { host: options.host, transport: 'raw9100' },
    retryable: true,
    cause: lastError,
  });
}

interface WriteOptions {
  host: string;
  port: number;
  payload: Buffer;
  connectTimeoutMs: number;
  writeTimeoutMs: number;
}

function writeToSocket(options: WriteOptions): Promise<{ writeCompleted: boolean }> {
  return new Promise((resolve, reject) => {
    let writeCompleted = false;

    const socket = new Socket();
    let settled = false;
    let connected = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        (error as Error & { writeCompleted?: boolean }).writeCompleted = writeCompleted;
        reject(error);
      } else {
        resolve({ writeCompleted });
      }
    };

    socket.setTimeout(options.connectTimeoutMs);

    socket.once('timeout', () => {
      finish(
        new Error(
          connected
            ? `Write to ${options.host}:${options.port} stalled`
            : `Connection to ${options.host}:${options.port} timed out`,
        ),
      );
    });

    socket.once('error', (error) => finish(error));

    // Resolve on `close`, not on the write callback: the write callback fires
    // when the data is handed to the kernel, which is not the same as the
    // device having taken it.
    socket.once('close', (hadError) => {
      if (hadError) finish(new Error(`Connection to ${options.host} closed with an error`));
      else finish();
    });

    socket.connect(options.port, options.host, () => {
      connected = true;
      socket.setTimeout(options.writeTimeoutMs);
      socket.write(options.payload, (writeError) => {
        if (writeError) {
          finish(writeError);
          return;
        }
        writeCompleted = true;
        socket.end(); // half-close: FIN signals end-of-job
      });
    });
  });
}

/**
 * Reachability probe used by the status watcher.
 *
 * §B7.4 replaces the delivered build's ICMP ping with a TCP connect, for two
 * reasons: it costs no OS process, and it tests the port that actually carries
 * print traffic. A device answering ping while 9100 is closed is offline for
 * every purpose this system cares about.
 */
export function probePort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host, () => done(true));
  });
}

function isConnectionReset(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'EPIPE';
}
