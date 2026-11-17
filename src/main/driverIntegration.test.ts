import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GauzeCore } from '@shared/core';
import { CH, CHANNELS_PER_MODULE } from '@shared/dmx';
import { buildEnttecMk2InitFrames } from '@shared/protocols';
import type { ModuleCfg, OutputSettings } from '@shared/types';

interface PendingWrite {
  fd: number;
  bytes: Buffer;
  cb: (err: Error | null, written?: number) => void;
}

interface PendingUdpSend {
  pkt: Buffer;
  port: number;
  ip: string;
  cb: (err?: Error | null) => void;
}

const mocks = vi.hoisted(() => ({
  serial: {
    nextFd: 77,
    openCalls: 0,
    pendingWrites: [] as PendingWrite[],
    completedWrites: [] as Buffer[],
    closedFds: [] as number[],
    reset() {
      this.nextFd = 77;
      this.openCalls = 0;
      this.pendingWrites = [];
      this.completedWrites = [];
      this.closedFds = [];
    },
  },
  win: {
    procs: [] as Array<
      EventEmitter & {
        stdin: { writable: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stderr: EventEmitter;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
        stdinLines: string[];
        stdinEnded: boolean;
      }
    >,
    reset() {
      this.procs = [];
    },
  },
  udp: {
    failBindPorts: new Set<number>(),
    sockets: [] as Array<{
      boundPort: number | null;
      closed: boolean;
      pendingSends: PendingUdpSend[];
      completedSends: PendingUdpSend[];
      emitter: EventEmitter;
    }>,
    reset() {
      this.failBindPorts.clear();
      this.sockets = [];
    },
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
  const spawn = vi.fn(() => {
    const proc = new EventEmitter() as (typeof mocks.win.procs)[number];
    proc.stdinLines = [];
    proc.stdinEnded = false;
    proc.killed = false;
    proc.stderr = new EventEmitter();
    proc.stdin = {
      writable: true,
      write: vi.fn((line: string) => {
        proc.stdinLines.push(line);
        return true;
      }),
      end: vi.fn(() => {
        proc.stdinEnded = true;
      }),
    };
    proc.kill = vi.fn(() => {
      proc.killed = true;
      return true;
    });
    mocks.win.procs.push(proc);
    return proc;
  });
  return { execFile, spawn, default: { execFile, spawn } };
});

vi.mock('node:fs', () => {
  const fsMock = {
    constants: { O_WRONLY: 1, O_NONBLOCK: 4 },
    open: vi.fn((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as
        | ((err: Error | null, fd: number) => void)
        | undefined;
      mocks.serial.openCalls += 1;
      const fd = mocks.serial.nextFd++;
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
      if (cb) {
        mocks.serial.pendingWrites.push({ fd, bytes: chunk, cb });
      }
    }),
    close: vi.fn((fd: number, cb?: (err: Error | null) => void) => {
      mocks.serial.closedFds.push(fd);
      if (cb) queueMicrotask(() => cb(null));
    }),
  };
  return { ...fsMock, default: fsMock };
});

vi.mock('node:dgram', () => {
  const createSocket = vi.fn(() => {
    const ee = new EventEmitter() as EventEmitter & {
      bind: (port: number, cb?: () => void) => void;
      setBroadcast: (flag: boolean) => void;
      setMulticastTTL: (ttl: number) => void;
      send: (pkt: Uint8Array, port: number, ip: string, cb?: (err?: Error | null) => void) => void;
      close: () => void;
    };
    const record = {
      boundPort: null as number | null,
      closed: false,
      pendingSends: [] as PendingUdpSend[],
      completedSends: [] as PendingUdpSend[],
      emitter: ee,
    };
    mocks.udp.sockets.push(record);
    ee.bind = (port: number, cb?: () => void) => {
      record.boundPort = port;
      if (mocks.udp.failBindPorts.has(port)) {
        queueMicrotask(() => {
          const err = Object.assign(new Error(`bind EADDRINUSE 0.0.0.0:${port}`), { code: 'EADDRINUSE' });
          ee.emit('error', err);
        });
        return;
      }
      if (cb) queueMicrotask(() => cb());
    };
    ee.setBroadcast = () => {};
    ee.setMulticastTTL = () => {};
    ee.send = (pkt: Uint8Array, port: number, ip: string, cb?: (err?: Error | null) => void) => {
      const entry: PendingUdpSend = {
        pkt: Buffer.from(pkt),
        port,
        ip,
        cb: (err) => cb?.(err ?? null),
      };
      record.pendingSends.push(entry);
    };
    ee.close = () => {
      record.closed = true;
    };
    return ee;
  });
  return { createSocket, default: { createSocket } };
});

import { ArtNetDriver } from './artnetDriver';
import { KinetDriver } from './kinetDriver';
import { SacnDriver } from './sacnDriver';
import { SerialDmxDriver } from './serialDriver';

function makeMod(id: string, startAddress: number): ModuleCfg {
  return {
    id,
    name: id,
    layerId: 'layer-1',
    visible: true,
    length: 4,
    width: 1,
    minHeight: 0,
    maxHeight: 4,
    startAddress,
    maxSpeedCms: 100,
    defaultSpeed: 100,
  };
}

function serialOutput(driver: 'enttec-mk2' | 'enttec-pro' = 'enttec-mk2'): OutputSettings {
  return {
    driver,
    ip: '127.0.0.1',
    port: 6454,
    net: 0,
    subnet: 0,
    universe: 0,
    sendHz: 40,
    serialPort: '/dev/cu.usbserial-INTEG',
    baudRate: 57600,
    enttecMk2Port: 1,
  };
}

function udpOutput(driver: 'artnet' | 'sacn' | 'kinet', ip = 'stage-node.local'): OutputSettings {
  return {
    driver,
    ip,
    port: driver === 'artnet' ? 6454 : driver === 'sacn' ? 5568 : 6038,
    net: 0,
    subnet: 0,
    universe: 0,
    sendHz: 40,
    sacnMulticast: false,
    kinetVersion: 2,
    kinetPort: 1,
  };
}

function completeNextSerialWrite(): Buffer {
  const next = mocks.serial.pendingWrites.shift();
  if (!next) throw new Error('Expected a pending fs.write');
  mocks.serial.completedWrites.push(next.bytes);
  next.cb(null, next.bytes.length);
  return next.bytes;
}

describe('Core + Async Driver integration cleanup & drain tests', () => {
  beforeEach(() => {
    mocks.serial.reset();
    mocks.win.reset();
    mocks.udp.reset();
    vi.clearAllMocks();
  });

  it('Core -> POSIX Serial preserves full high-channel zero flush across rapid shrink ticks while fs.write is busy', async () => {
    let nowMs = 1000;
    const core = new GauzeCore((cfg, ev) => new SerialDmxDriver(cfg, ev), () => nowMs);
    const out = serialOutput('enttec-mk2');
    const lo = makeMod('lo', 1);
    const hi = makeMod('hi', 509);

    core.configure({ modules: [lo, hi], output: out, lockValue: 77 });

    // Drain Enttec Mk2 2-frame init sequence first.
    const [init1, init2] = buildEnttecMk2InitFrames();
    await vi.waitFor(() => expect(mocks.serial.pendingWrites.length).toBe(1));
    expect(completeNextSerialWrite()).toEqual(Buffer.from(init1));
    await vi.waitFor(() => expect(mocks.serial.pendingWrites.length).toBe(1));
    expect(completeNextSerialWrite()).toEqual(Buffer.from(init2));

    // Unlock and send initial 518-byte Enttec frame with hi@509 CH4=77 held in flight.
    core.command({ type: 'lock', locked: false });
    nowMs += 25;
    core.tick();

    expect(mocks.serial.pendingWrites.length).toBe(1);
    const busyInitial = mocks.serial.pendingWrites[0].bytes;
    expect(busyInitial.length).toBe(518); // 5 header + 512 dmx + 1 end byte
    expect(busyInitial[5 + (hi.startAddress - 1) + CH.LOCK]).toBe(77);

    // While write #0 is still busy: remove hi, tick once (long clear) and tick again (short lo-only).
    core.configure({ modules: [lo], output: out, lockValue: 77 });
    nowMs += 25;
    core.tick();
    nowMs += 25;
    core.tick();

    // Release busy write #0 -> queued clear frame must STILL be 518 bytes and zero hi channels!
    completeNextSerialWrite();
    expect(mocks.serial.pendingWrites.length).toBe(1);
    const clearFrame = completeNextSerialWrite();
    expect(clearFrame.length).toBe(518);
    expect(clearFrame[5 + (lo.startAddress - 1) + CH.LOCK]).toBe(77);
    for (let ch = 0; ch < CHANNELS_PER_MODULE; ch += 1) {
      expect(clearFrame[5 + (hi.startAddress - 1) + ch]).toBe(0);
    }

    core.stop();
    while (mocks.serial.pendingWrites.length > 0) {
      completeNextSerialWrite();
    }
    await vi.waitFor(() => expect(mocks.serial.closedFds.length).toBe(1));
  });

  it('Core.stop() while POSIX Serial fs.write is busy delivers final all-zero frame before closing fd', async () => {
    let nowMs = 2000;
    const core = new GauzeCore((cfg, ev) => new SerialDmxDriver(cfg, ev), () => nowMs);
    const out = serialOutput('enttec-pro');
    const lo = makeMod('lo', 1);

    core.configure({ modules: [lo], output: out, lockValue: 77 });
    core.command({ type: 'lock', locked: false });

    // Wait for fs.open to settle, then start one unlocked write and hold it busy.
    await vi.waitFor(() => {
      nowMs += 25;
      core.tick();
      expect(mocks.serial.pendingWrites.length).toBe(1);
    });

    const firstBusy = mocks.serial.pendingWrites[0].bytes;
    expect(firstBusy[5 + CH.LOCK]).toBe(77);

    // Call core.stop() while first write is still in flight.
    core.stop();
    expect(mocks.serial.closedFds).toEqual([]);

    // Release busy write -> zero flush frame must start writing, and fd still stays open until flush completes.
    completeNextSerialWrite();
    expect(mocks.serial.closedFds).toEqual([]);
    expect(mocks.serial.pendingWrites.length).toBe(1);

    const stopZeroFrame = completeNextSerialWrite();
    for (let i = 5; i < stopZeroFrame.length - 1; i += 1) {
      expect(stopZeroFrame[i]).toBe(0);
    }
    expect(mocks.serial.closedFds).toEqual([77]);
  });

  it('GauzeCore + ArtNetDriver defers sock.close until async DNS/UDP zero flush completes on core.stop()', async () => {
    let nowMs = 3000;
    const core = new GauzeCore((cfg, ev) => new ArtNetDriver(cfg, ev), () => nowMs);
    const lo = makeMod('lo', 1);
    core.configure({ modules: [lo], output: udpOutput('artnet', 'host-needing-dns.local'), lockValue: 77 });
    core.command({ type: 'lock', locked: false });

    // Wait for async sock.bind callback.
    await vi.waitFor(() => {
      nowMs += 25;
      core.tick();
      expect(mocks.udp.sockets[0]?.pendingSends.length).toBeGreaterThanOrEqual(1);
    });

    const sock = mocks.udp.sockets[0];
    while (sock.pendingSends.length > 0) {
      const s = sock.pendingSends.shift()!;
      sock.completedSends.push(s);
      s.cb(null);
    }

    // Now stop core: sends final zero ArtDmx packet, immediately calls driver.stop().
    core.stop();
    expect(sock.pendingSends.length).toBe(1);
    expect(sock.closed).toBe(false);

    // Inspect zero payload at end of Art-Net packet (18-byte header + DMX data).
    const flushSend = sock.pendingSends.shift()!;
    expect(flushSend.pkt.subarray(18)).toEqual(Buffer.alloc(flushSend.pkt.length - 18, 0));

    // Completing async DNS/UDP send callback now cleanly closes socket.
    flushSend.cb(null);
    expect(sock.closed).toBe(true);
  });

  it('SacnDriver and KinetDriver hold sockets open through in-flight send callbacks across immediate stop()', async () => {
    for (const [idx, kind] of (['sacn', 'kinet'] as const).entries()) {
      const ev = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() };
      const cfg = udpOutput(kind, `udp-${kind}.local`);
      const driver = kind === 'sacn' ? new SacnDriver(cfg, ev) : new KinetDriver(cfg, ev);
      driver.start();

      const sock = mocks.udp.sockets[idx];
      await vi.waitFor(() => {
        driver.send(0, 0, new Uint8Array([0, 0, 0, 0]));
        expect(sock.pendingSends.length).toBe(1);
      });

      driver.stop();
      expect(sock.closed).toBe(false);

      sock.pendingSends.shift()!.cb(null);
      expect(sock.closed).toBe(true);
    }
  });

  it('waits for async old POSIX fd flush & close before opening new driver on same serial port', async () => {
    let nowMs = 4000;
    const core = new GauzeCore((cfg, ev) => new SerialDmxDriver(cfg, ev), () => nowMs);
    const out1 = serialOutput('enttec-pro');
    const out2: OutputSettings = { ...out1, driver: 'serial', serialFormat: 'enttec' };
    const lo = makeMod('lo', 1);

    core.configure({ modules: [lo], output: out1, lockValue: 77 });
    core.command({ type: 'lock', locked: false });

    await vi.waitFor(() => {
      nowMs += 25;
      core.tick();
      expect(mocks.serial.pendingWrites.length).toBe(1);
    });
    expect(mocks.serial.openCalls).toBe(1);

    // Reconfigure synchronously on the SAME serialPort while first write is in flight.
    core.configure({ modules: [lo], output: out2, lockValue: 77 });
    await new Promise((r) => setTimeout(r, 15));

    // Old fd still has pending flush after write #0, so new driver must NOT open port yet!
    expect(mocks.serial.openCalls).toBe(1);
    expect(mocks.serial.closedFds).toEqual([]);

    // Complete write #0 -> old driver drains zero flush -> still hasn't opened port #2 until zero flush closes fd.
    completeNextSerialWrite();
    expect(mocks.serial.openCalls).toBe(1);
    expect(mocks.serial.pendingWrites.length).toBe(1);

    completeNextSerialWrite();
    await vi.waitFor(() => {
      expect(mocks.serial.closedFds).toEqual([77]);
      expect(mocks.serial.openCalls).toBe(2);
    });

    core.stop();
    await vi.waitFor(() => {
      while (mocks.serial.pendingWrites.length > 0) {
        completeNextSerialWrite();
      }
      expect(mocks.serial.closedFds).toEqual([77, 78]);
    });
  });

  it('waits for graceful old Windows SerialPort process EOF exit before spawning new process on same COM port', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      let nowMs = 5000;
      const core = new GauzeCore((cfg, ev) => new SerialDmxDriver(cfg, ev), () => nowMs);
      const out1: OutputSettings = {
        ...serialOutput('enttec-mk2'),
        serialPort: 'COM7',
        sendHz: 40,
        enttecMk2Port: 1,
      };
      const out2: OutputSettings = {
        ...out1,
        serialPort: 'com7', // same COM port case-insensitively on Windows with sendHz 40 -> 30
        sendHz: 30,
      };
      const lo = makeMod('lo', 1);

      core.configure({ modules: [lo], output: out1, lockValue: 77 });
      await vi.waitFor(() => expect(mocks.win.procs.length).toBe(1));
      const proc1 = mocks.win.procs[0];

      core.command({ type: 'lock', locked: false });
      nowMs += 25;
      core.tick();

      // Reconfigure onto same COM7 (sendHz 40 -> 30): old process receives zeros + stdin.end(), stays alive momentarily.
      core.configure({ modules: [lo], output: out2, lockValue: 77 });
      await new Promise((r) => setTimeout(r, 15));

      expect(proc1.stdinEnded).toBe(true);
      expect(proc1.kill).not.toHaveBeenCalled();
      expect(mocks.win.procs.length).toBe(1); // New process MUST NOT spawn while old proc still holds COM7!

      // Simulate PowerShell $sp.Close() finishing and process exiting cleanly.
      proc1.emit('exit', 0);
      await vi.waitFor(() => expect(mocks.win.procs.length).toBe(2));

      const proc2 = mocks.win.procs[1];
      core.stop();
      proc2.emit('exit', 0);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('ArtNetDriver binds ephemeral port 0 (never steals 6454 on localhost, sends even if 6454 is busy) and SacnDriver binds 0 sending to 127.0.0.1:5568', async () => {
    const ev = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() };

    // 1) Localhost/127.0.0.1: ArtNetDriver binds ephemeral port 0, guards legacy port 5568 -> target 6454,
    // and does NOT bind 6454 even when poll() runs.
    const artnetLocal = new ArtNetDriver({ ...udpOutput('artnet', '127.0.0.1'), port: 5568 }, ev);
    artnetLocal.start();
    const localSock = mocks.udp.sockets[0];
    expect(localSock.boundPort).toBe(0);
    await vi.waitFor(() => {
      artnetLocal.poll();
      artnetLocal.send(0, 0, new Uint8Array([10, 20, 30, 77]));
      expect(localSock.pendingSends.length).toBe(2);
    });
    expect(mocks.udp.sockets).toHaveLength(1); // No 6454 listener socket created for 127.0.0.1
    expect(localSock.pendingSends[0].ip).toBe('127.0.0.1');
    expect(localSock.pendingSends[0].port).toBe(6454);
    expect(localSock.pendingSends[1].ip).toBe('127.0.0.1');
    expect(localSock.pendingSends[1].port).toBe(6454);
    localSock.pendingSends.splice(0).forEach((s) => s.cb(null));
    artnetLocal.stop();

    // Also verify 'localhost' never grabs 6454.
    const artnetHost = new ArtNetDriver({ ...udpOutput('artnet', 'localhost'), port: 6454 }, ev);
    artnetHost.start();
    const hostSock = mocks.udp.sockets[1];
    expect(hostSock.boundPort).toBe(0);
    await vi.waitFor(() => {
      artnetHost.poll();
      artnetHost.send(0, 0, new Uint8Array([1, 2, 3, 77]));
      expect(hostSock.pendingSends.length).toBe(2);
    });
    expect(mocks.udp.sockets).toHaveLength(2);
    hostSock.pendingSends.splice(0).forEach((s) => s.cb(null));
    artnetHost.stop();

    // 2) SacnDriver binds ephemeral port 0 (no conflict with TD dmx_in on 127.0.0.1:5568) and maps universe = sacnUniverse ?? universe + 1.
    const sacnDefaultUni = new SacnDriver(
      { ...udpOutput('sacn', '127.0.0.1'), universe: 0, sacnUniverse: undefined, sacnMulticast: false },
      ev,
    );
    sacnDefaultUni.start();
    const sacnSock = mocks.udp.sockets[2];
    expect(sacnSock.boundPort).toBe(0);
    await vi.waitFor(() => {
      sacnDefaultUni.send(0, 0, new Uint8Array([10, 20, 30, 77]));
      expect(sacnSock.pendingSends.length).toBe(1);
    });
    const pkt1 = sacnSock.pendingSends.shift()!;
    expect(pkt1.ip).toBe('127.0.0.1');
    expect(pkt1.port).toBe(5568);
    expect((pkt1.pkt[113] << 8) | pkt1.pkt[114]).toBe(1); // universe 0 + 1 = 1
    pkt1.cb(null);
    sacnDefaultUni.stop();

    const sacnExplicitUni = new SacnDriver(
      { ...udpOutput('sacn', '127.0.0.1'), universe: 0, sacnUniverse: 5, sacnMulticast: false },
      ev,
    );
    sacnExplicitUni.start();
    const sacnSock2 = mocks.udp.sockets[3];
    await vi.waitFor(() => {
      sacnExplicitUni.send(0, 0, new Uint8Array([10, 20, 30, 77]));
      expect(sacnSock2.pendingSends.length).toBe(1);
    });
    const pkt2 = sacnSock2.pendingSends.shift()!;
    expect((pkt2.pkt[113] << 8) | pkt2.pkt[114]).toBe(5);
    pkt2.cb(null);
    sacnExplicitUni.stop();
  });

  it('ArtNetDriver keeps sending ArtDmx when port 6454 is busy on non-loopback target, warns cleanly, and listens for ArtPollReply when free', async () => {
    const { buildArtPollReply } = await import('@shared/artnet');

    // Busy 6454: rxSock fails with EADDRINUSE -> emits onWarn, disables ArtPollReply listener, sendSock still sends ArtDmx!
    mocks.udp.failBindPorts.add(6454);
    const evBusy = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() };
    const busyDriver = new ArtNetDriver({ ...udpOutput('artnet', '192.168.1.50'), port: 6454 }, evBusy);
    busyDriver.start();
    const busySendSock = mocks.udp.sockets[0];
    expect(busySendSock.boundPort).toBe(0);

    await vi.waitFor(() => {
      busyDriver.poll();
      expect(mocks.udp.sockets).toHaveLength(2);
    });
    const busyRxSock = mocks.udp.sockets[1];
    expect(busyRxSock.boundPort).toBe(6454);

    await vi.waitFor(() => {
      expect(busyRxSock.closed).toBe(true);
      expect(evBusy.onWarn).toHaveBeenCalledWith(expect.stringContaining('Cổng 6454 đang bận'));
    });

    // send() must still succeed even though 6454 listener failed!
    busyDriver.send(0, 1, new Uint8Array([128, 0, 100, 77]));
    const dmxSend = busySendSock.pendingSends.find((s) => s.pkt[8] === 0x00 && s.pkt[9] === 0x50);
    expect(dmxSend).toBeDefined();
    expect(dmxSend!.ip).toBe('192.168.1.50');
    expect(dmxSend!.port).toBe(6454);
    expect(evBusy.onError).not.toHaveBeenCalledWith(expect.any(String));

    busySendSock.pendingSends.splice(0).forEach((s) => s.cb(null));
    busyDriver.stop();
    expect(busySendSock.closed).toBe(true);

    // Free 6454 on non-loopback target: poll() binds 6454 and receives ArtPollReply
    mocks.udp.failBindPorts.clear();
    mocks.udp.reset();
    const evFree = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() };
    const freeDriver = new ArtNetDriver({ ...udpOutput('artnet', '192.168.1.50'), port: 6454 }, evFree);
    freeDriver.start();
    await vi.waitFor(() => {
      freeDriver.poll();
      expect(mocks.udp.sockets).toHaveLength(2);
    });
    const freeSendSock = mocks.udp.sockets[0];
    const freeRxSock = mocks.udp.sockets[1];
    expect(freeSendSock.boundPort).toBe(0);
    expect(freeRxSock.boundPort).toBe(6454);

    const replyPkt = buildArtPollReply([192, 168, 1, 50], 'StageNode', 'Stage Art-Net Node');
    freeRxSock.emitter.emit('message', Buffer.from(replyPkt), { address: '192.168.1.50', port: 6454 });
    expect(evFree.onNode).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '192.168.1.50', name: 'StageNode' }),
    );

    freeSendSock.pendingSends.splice(0).forEach((s) => s.cb(null));
    freeDriver.stop();
    expect(freeRxSock.closed).toBe(true);
    expect(freeSendSock.closed).toBe(true);
  });
});
