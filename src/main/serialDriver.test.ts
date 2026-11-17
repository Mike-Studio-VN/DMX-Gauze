import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverEvents } from '@shared/drivers';
import { buildEnttecMk2Frame, buildEnttecMk2InitFrames } from '@shared/protocols';
import type { OutputSettings } from '@shared/types';

interface PendingWrite {
  fd: number;
  bytes: Buffer;
  cb: (err: Error | null, written?: number) => void;
}

const fakeIo = vi.hoisted(() => ({
  nextFd: 42,
  openCalls: [] as Array<{ path: string; flags: number }>,
  startedWrites: [] as Buffer[],
  pendingWrites: [] as PendingWrite[],
  closedFds: [] as number[],
  reset() {
    this.nextFd = 42;
    this.openCalls = [];
    this.startedWrites = [];
    this.pendingWrites = [];
    this.closedFds = [];
  },
}));

vi.mock('node:child_process', () => {
  const execFile = vi.fn((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    if (cb) queueMicrotask(() => cb(null, '', ''));
    return {};
  });
  const spawn = vi.fn();
  return {
    execFile,
    spawn,
    default: { execFile, spawn },
  };
});

vi.mock('node:fs', () => {
  const fsMock = {
    constants: { O_WRONLY: 1, O_NONBLOCK: 4 },
    open: vi.fn((...args: unknown[]) => {
      const filePath = String(args[0]);
      const flags = Number(args[1]);
      const cb = args.find((a) => typeof a === 'function') as
        | ((err: Error | null, fd: number) => void)
        | undefined;
      fakeIo.openCalls.push({ path: filePath, flags });
      const fd = fakeIo.nextFd;
      if (cb) queueMicrotask(() => cb(null, fd));
    }),
    write: vi.fn((...args: unknown[]) => {
      const fd = Number(args[0]);
      const buf = args[1] as Buffer;
      const offset = Number(args[2] ?? 0);
      const length = Number(args[3] ?? buf.length - offset);
      const cb = args.find((a) => typeof a === 'function') as
        | ((err: Error | null, written?: number) => void)
        | undefined;
      const chunk = Buffer.from(buf.subarray(offset, offset + length));
      fakeIo.startedWrites.push(chunk);
      if (cb) {
        fakeIo.pendingWrites.push({ fd, bytes: chunk, cb });
      }
    }),
    close: vi.fn((fd: number, cb?: (err: Error | null) => void) => {
      fakeIo.closedFds.push(fd);
      if (cb) queueMicrotask(() => cb(null));
    }),
  };
  return {
    ...fsMock,
    default: fsMock,
  };
});

import { SerialDmxDriver } from './serialDriver';

function makeSettings(): OutputSettings {
  return {
    driver: 'enttec-mk2',
    ip: '127.0.0.1',
    port: 6454,
    net: 0,
    subnet: 0,
    universe: 0,
    sendHz: 40,
    serialPort: '/dev/tty.usbserial-FAKE01',
    baudRate: 57600,
    enttecMk2Port: 1,
  };
}

function makeEvents(): DriverEvents & { errors: Array<string | null> } {
  const errors: Array<string | null> = [];
  return {
    errors,
    onNode: vi.fn(),
    onError: vi.fn((msg) => {
      errors.push(msg);
    }),
    onWarn: vi.fn(),
  };
}

async function waitForWrites(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(fakeIo.startedWrites.length).toBeGreaterThanOrEqual(count);
  });
}

describe('SerialDmxDriver POSIX init queue and write safety (Bug 7)', () => {
  beforeEach(() => {
    fakeIo.reset();
    vi.clearAllMocks();
  });

  it('queues both Enttec Mk2 init frames in strict FIFO order without dropping frame 2 while writing=true', async () => {
    const [initFrame1, initFrame2] = buildEnttecMk2InitFrames();
    const ev = makeEvents();
    const driver = new SerialDmxDriver(makeSettings(), ev);

    driver.start();
    await waitForWrites(1);

    // First init frame is in flight; second must wait rather than overlapping or dropping.
    expect(Buffer.from(fakeIo.startedWrites[0])).toEqual(Buffer.from(initFrame1));
    expect(fakeIo.startedWrites.length).toBe(1);

    // Enqueue DMX frames while init frame 1 is still pending; latest frame should coalesce after init.
    const dmxA = new Uint8Array(24);
    dmxA[0] = 11;
    const dmxB = new Uint8Array(24);
    dmxB[0] = 77;
    driver.send(0, 0, dmxA);
    driver.send(0, 0, dmxB);
    expect(fakeIo.startedWrites.length).toBe(1);

    // Complete frame 1 -> frame 2 must now start cleanly.
    const w0 = fakeIo.pendingWrites.shift()!;
    w0.cb(null, w0.bytes.length);
    await waitForWrites(2);
    expect(Buffer.from(fakeIo.startedWrites[1])).toEqual(Buffer.from(initFrame2));
    expect(fakeIo.startedWrites.length).toBe(2);

    // Complete frame 2 -> coalesced DMX frame B must now write.
    const w1 = fakeIo.pendingWrites.shift()!;
    w1.cb(null, w1.bytes.length);
    await waitForWrites(3);
    expect(Buffer.from(fakeIo.startedWrites[2])).toEqual(
      Buffer.from(buildEnttecMk2Frame(dmxB, 1)),
    );

    driver.stop();
    const w2 = fakeIo.pendingWrites.shift()!;
    w2.cb(null, w2.bytes.length);
    await vi.waitFor(() => expect(fakeIo.closedFds).toEqual([fakeIo.nextFd]));
  });

  it('finishes partial fs.write chunks before dequeuing the next control frame', async () => {
    const [initFrame1, initFrame2] = buildEnttecMk2InitFrames();
    const ev = makeEvents();
    const driver = new SerialDmxDriver(makeSettings(), ev);

    driver.start();
    await waitForWrites(1);
    expect(Buffer.from(fakeIo.startedWrites[0])).toEqual(Buffer.from(initFrame1));

    const w0 = fakeIo.pendingWrites.shift()!;
    w0.cb(null, 4);
    await waitForWrites(2);
    expect(Buffer.from(fakeIo.startedWrites[1])).toEqual(Buffer.from(initFrame1.subarray(4)));

    const w1 = fakeIo.pendingWrites.shift()!;
    w1.cb(null, w1.bytes.length);
    await waitForWrites(3);
    expect(Buffer.from(fakeIo.startedWrites[2])).toEqual(Buffer.from(initFrame2));

    driver.stop();
    const w2 = fakeIo.pendingWrites.shift()!;
    w2.cb(null, w2.bytes.length);
    await vi.waitFor(() => expect(fakeIo.closedFds).toEqual([fakeIo.nextFd]));
  });

  it('clears pending writes and surfaces write errors while running', async () => {
    const ev = makeEvents();
    const driver = new SerialDmxDriver(makeSettings(), ev);

    driver.start();
    await waitForWrites(1);

    const dmx = new Uint8Array(24);
    dmx[0] = 99;
    driver.send(0, 0, dmx);

    const w0 = fakeIo.pendingWrites.shift()!;
    w0.cb(new Error('EIO fake serial error'));

    await vi.waitFor(() => {
      expect(ev.errors.some((e) => typeof e === 'string' && e.includes('EIO fake serial error'))).toBe(
        true,
      );
    });
    expect(fakeIo.startedWrites.length).toBe(1);
    driver.stop();
    await vi.waitFor(() => expect(fakeIo.closedFds).toEqual([fakeIo.nextFd]));
  });

  it('closes fd immediately on stop() when idle, or after in-flight error, suppressing post-stop error callbacks', async () => {
    const ev = makeEvents();
    const driver = new SerialDmxDriver(makeSettings(), ev);

    driver.start();
    await waitForWrites(1);
    const w0 = fakeIo.pendingWrites.shift()!;
    w0.cb(null, w0.bytes.length);
    await waitForWrites(2);
    const w1 = fakeIo.pendingWrites.shift()!;
    w1.cb(null, w1.bytes.length);

    // Idle stop closes fd immediately.
    driver.stop();
    expect(fakeIo.closedFds).toEqual([fakeIo.nextFd]);

    // Stopping while an in-flight write fails closes fd safely once callback returns and suppresses post-stop errors.
    fakeIo.reset();
    const ev2 = makeEvents();
    const driver2 = new SerialDmxDriver(makeSettings(), ev2);
    driver2.start();
    await waitForWrites(1);
    ev2.errors.length = 0;

    driver2.stop();
    expect(fakeIo.closedFds).toEqual([]);
    const inFlight = fakeIo.pendingWrites.shift()!;
    inFlight.cb(new Error('EBADF during stop'));
    await new Promise((r) => setTimeout(r, 15));

    expect(fakeIo.startedWrites.length).toBe(1);
    expect(fakeIo.closedFds).toEqual([fakeIo.nextFd]);
    expect(ev2.errors).toEqual([]);
  });

  it('drains queued init and final DMX frame before closing fd when stop() follows send()', async () => {
    const [initFrame1, initFrame2] = buildEnttecMk2InitFrames();
    const ev = makeEvents();
    const driver = new SerialDmxDriver(makeSettings(), ev);

    driver.start();
    await waitForWrites(1);
    const zeros = new Uint8Array(24);
    driver.send(0, 0, zeros);
    driver.stop();

    expect(fakeIo.closedFds).toEqual([]);

    const w0 = fakeIo.pendingWrites.shift()!;
    expect(Buffer.from(w0.bytes)).toEqual(Buffer.from(initFrame1));
    w0.cb(null, w0.bytes.length);
    await waitForWrites(2);

    const w1 = fakeIo.pendingWrites.shift()!;
    expect(Buffer.from(w1.bytes)).toEqual(Buffer.from(initFrame2));
    w1.cb(null, w1.bytes.length);
    await waitForWrites(3);

    const w2 = fakeIo.pendingWrites.shift()!;
    expect(Buffer.from(w2.bytes)).toEqual(Buffer.from(buildEnttecMk2Frame(zeros, 1)));
    expect(fakeIo.closedFds).toEqual([]);
    w2.cb(null, w2.bytes.length);

    expect(fakeIo.closedFds).toEqual([fakeIo.nextFd]);
  });
});
