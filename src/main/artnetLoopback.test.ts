import dgram from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildArtPollReply } from '@shared/artnet'
import type { OutputSettings } from '@shared/types'
import { ArtNetDriver } from './artnetDriver'

function loopbackCfg(port: number): OutputSettings {
  return {
    driver: 'artnet',
    ip: '127.0.0.1',
    port,
    net: 0,
    subnet: 0,
    universe: 1,
    sendHz: 25,
  }
}

async function bindLoopbackUdp(reuseAddr = false, addr = '127.0.0.1'): Promise<{ sock: dgram.Socket; port: number }> {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr })
  const port = await new Promise<number>((resolve, reject) => {
    sock.once('error', reject)
    sock.bind(0, addr, () => resolve(sock.address().port))
  })
  return { sock, port }
}

describe('ArtNetDriver real loopback high-port socket routing & cooperation proof (127.0.0.1 only, no broadcast)', () => {
  const openSockets: dgram.Socket[] = []

  afterEach(async () => {
    while (openSockets.length > 0) {
      const s = openSockets.pop()!
      await new Promise<void>((resolve) => {
        try {
          s.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
  })

  it('delivers 10/10 ArtDmx frames to an active exclusive local receiver on same port, preserves receiver exclusivity, emits indeterminate discovery warning, and accepts cooperative source-port replies', async () => {
    const { sock: localReceiver, port: recvPort } = await bindLoopbackUdp(false, '127.0.0.1')
    openSockets.push(localReceiver)

    const receivedDmx: Buffer[] = []
    let receivedPollCount = 0
    let replyToSource = false
    localReceiver.on('message', (msg, rinfo) => {
      if (msg.length >= 10 && msg.subarray(0, 8).toString('ascii') === 'Art-Net\0') {
        const opCode = msg.readUInt16LE(8)
        if (opCode === 0x2000) {
          receivedPollCount += 1
          if (replyToSource) {
            const reply = buildArtPollReply([127, 0, 0, 1], 'Coop-Local', 'Cooperative Loopback Node')
            localReceiver.send(reply, rinfo.port, '127.0.0.1')
          }
        } else if (opCode === 0x5000) {
          receivedDmx.push(Buffer.from(msg))
        }
      }
    })

    const ev = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() }
    const driver = new ArtNetDriver(loopbackCfg(recvPort), ev, { listenPort: recvPort })
    driver.start()

    try {
      // Wait for async sock.bind(0) -> markReady() before polling & sending 10 sequential ArtDmx frames.
      await vi.waitFor(() => {
        driver.poll()
        expect(receivedPollCount).toBeGreaterThanOrEqual(1)
      }, { timeout: 2000 })

      for (let i = 0; i < 10; i += 1) {
        driver.send(0, 1, new Uint8Array([100 + i, 0, 255, 77]))
      }

      await vi.waitFor(() => {
        expect(receivedDmx.length).toBe(10)
      }, { timeout: 2000 })

      expect(ev.onWarn).toHaveBeenCalledWith(expect.stringContaining(`Đích localhost:${recvPort}`))
      expect(ev.onError).not.toHaveBeenCalledWith(expect.any(String))

      // Prove localReceiver still holds exclusive ownership of recvPort while driver is active.
      const probe = dgram.createSocket({ type: 'udp4', reuseAddr: false })
      openSockets.push(probe)
      const bindErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        probe.once('error', (err) => resolve(err as NodeJS.ErrnoException))
        probe.bind(recvPort, '127.0.0.1', () => resolve(null))
      })
      expect(bindErr?.code).toBe('EADDRINUSE')

      // Cooperative reply forwarded back to the ephemeral ArtPoll source port discovers node & clears warning.
      replyToSource = true
      await vi.waitFor(() => {
        driver.poll()
        expect(ev.onNode).toHaveBeenCalledWith(
          expect.objectContaining({ ip: '127.0.0.1', name: 'Coop-Local' }),
        )
      }, { timeout: 2000 })
      expect(ev.onWarn).toHaveBeenLastCalledWith(null)
    } finally {
      driver.stop()
    }
  })

  it('discovers standard ArtPollReply addressed to listenPort on loopback when receiver uses a different target port', async () => {
    const { sock: localReceiver, port: recvPort } = await bindLoopbackUdp(false, '127.0.0.1')
    openSockets.push(localReceiver)
    const { sock: tempListen, port: listenPort } = await bindLoopbackUdp(false, '0.0.0.0')
    await new Promise<void>((resolve) => tempListen.close(() => resolve()))

    let receivedDmx = 0
    localReceiver.on('message', (msg) => {
      if (msg.length >= 10 && msg.subarray(0, 8).toString('ascii') === 'Art-Net\0') {
        const opCode = msg.readUInt16LE(8)
        if (opCode === 0x2000) {
          const reply = buildArtPollReply([127, 0, 0, 1], 'StdLocal', 'Standard Reply Local Node')
          localReceiver.send(reply, listenPort, '127.0.0.1')
        } else if (opCode === 0x5000) {
          receivedDmx += 1
        }
      }
    })

    const ev = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() }
    const driver = new ArtNetDriver(loopbackCfg(recvPort), ev, { listenPort })
    driver.start()

    try {
      await vi.waitFor(() => {
        driver.poll()
        driver.send(0, 1, new Uint8Array([200, 0, 128, 77]))
        expect(receivedDmx).toBeGreaterThanOrEqual(1)
        expect(ev.onNode).toHaveBeenCalledWith(
          expect.objectContaining({ ip: '127.0.0.1', name: 'StdLocal' }),
        )
      }, { timeout: 2000 })
      expect(ev.onError).not.toHaveBeenCalledWith(expect.any(String))
    } finally {
      driver.stop()
    }
  })

  it('continues delivering ArtDmx on loopback when listenPort is exclusively occupied on 0.0.0.0 by another process', async () => {
    const { sock: localReceiver, port: recvPort } = await bindLoopbackUdp(false, '127.0.0.1')
    const { sock: blocker, port: busyListenPort } = await bindLoopbackUdp(false, '0.0.0.0')
    openSockets.push(localReceiver, blocker)

    let receivedDmx = 0
    localReceiver.on('message', (msg) => {
      if (msg.length >= 10 && msg.readUInt16LE(8) === 0x5000) {
        receivedDmx += 1
      }
    })

    const ev = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() }
    const driver = new ArtNetDriver(loopbackCfg(recvPort), ev, { listenPort: busyListenPort })
    driver.start()

    try {
      await vi.waitFor(() => {
        driver.poll()
        driver.send(0, 1, new Uint8Array([64, 0, 100, 77]))
        expect(ev.onWarn).toHaveBeenCalledWith(expect.stringContaining(`Cổng ${busyListenPort} đang bận`))
        expect(receivedDmx).toBeGreaterThanOrEqual(1)
      }, { timeout: 2000 })
      expect(ev.onError).not.toHaveBeenCalledWith(expect.any(String))
    } finally {
      driver.stop()
    }
  })
})
