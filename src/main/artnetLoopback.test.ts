import dgram from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildArtPollReply } from '@shared/artnet'
import { ARTNET_PORT } from '@shared/dmx'
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

describe('ArtNetDriver real loopback UDP sockets (no broadcast)', () => {
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

  it('delivers real ArtDmx and ArtPoll to an already-running local receiver and discovers replies sent to the ephemeral source port', async () => {
    const localReceiver = dgram.createSocket('udp4')
    openSockets.push(localReceiver)

    const recvPort = await new Promise<number>((resolve, reject) => {
      localReceiver.once('error', reject)
      localReceiver.bind(0, '127.0.0.1', () => resolve(localReceiver.address().port))
    })

    const receivedDmx: Buffer[] = []
    let receivedPollCount = 0
    localReceiver.on('message', (msg, rinfo) => {
      if (msg.length >= 10 && msg.subarray(0, 8).toString('ascii') === 'Art-Net\0') {
        const opCode = msg.readUInt16LE(8)
        if (opCode === 0x2000) {
          receivedPollCount += 1
          const reply = buildArtPollReply([127, 0, 0, 1], 'TD-Local', 'TouchDesigner Local')
          localReceiver.send(reply, rinfo.port, '127.0.0.1')
        } else if (opCode === 0x5000) {
          receivedDmx.push(Buffer.from(msg))
        }
      }
    })

    const ev = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() }
    const driver = new ArtNetDriver(loopbackCfg(recvPort), ev)
    driver.start()

    try {
      await vi.waitFor(() => {
        driver.poll()
        driver.send(0, 1, new Uint8Array([128, 0, 255, 77]))
        expect(receivedPollCount).toBeGreaterThanOrEqual(1)
        expect(receivedDmx.length).toBeGreaterThanOrEqual(1)
        expect(ev.onNode).toHaveBeenCalledWith(
          expect.objectContaining({ ip: '127.0.0.1', name: 'TD-Local' }),
        )
      }, { timeout: 3000 })

      const pkt = receivedDmx[0]
      expect(pkt[14]).toBe(1) // SubUni = 1
      expect(pkt[15]).toBe(0) // Net = 0
      expect(pkt[18]).toBe(128)
      expect(pkt[19]).toBe(0)
      expect(pkt[20]).toBe(255)
      expect(pkt[21]).toBe(77)
      expect(ev.onError).not.toHaveBeenCalledWith(expect.any(String))
    } finally {
      driver.stop()
    }
  })

  it('sends real ArtDmx to 127.0.0.1:6454 without claiming 6454 or failing when local receiver holds 6454', async () => {
    const exclusive6454 = dgram.createSocket({ type: 'udp4', reuseAddr: false })
    let boundExclusive = false
    try {
      await new Promise<void>((resolve, reject) => {
        exclusive6454.once('error', reject)
        exclusive6454.bind(ARTNET_PORT, '127.0.0.1', () => {
          boundExclusive = true
          openSockets.push(exclusive6454)
          resolve()
        })
      })
    } catch {
      // Another local receiver (e.g. TouchDesigner) already owns 127.0.0.1:6454 on this machine.
      try {
        exclusive6454.close()
      } catch {
        /* ignore */
      }
    }

    const receivedOn6454: Buffer[] = []
    if (boundExclusive) {
      exclusive6454.on('message', (msg) => {
        if (msg.length >= 10 && msg.readUInt16LE(8) === 0x5000) {
          receivedOn6454.push(Buffer.from(msg))
        }
      })
    }

    const ev = { onNode: vi.fn(), onError: vi.fn(), onWarn: vi.fn() }
    const driver = new ArtNetDriver(loopbackCfg(ARTNET_PORT), ev)
    driver.start()

    try {
      driver.poll()
      driver.send(0, 1, new Uint8Array([64, 0, 100, 77]))
      if (boundExclusive) {
        await vi.waitFor(() => {
          expect(receivedOn6454.length).toBeGreaterThanOrEqual(1)
        }, { timeout: 2000 })
        expect(receivedOn6454[0][18]).toBe(64)
      } else {
        await new Promise((r) => setTimeout(r, 80))
      }
      expect(ev.onError).not.toHaveBeenCalledWith(expect.any(String))
      expect(ev.onWarn).not.toHaveBeenCalledWith(expect.stringContaining('6454'))
    } finally {
      driver.stop()
    }
  })
})
