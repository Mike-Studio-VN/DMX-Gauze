import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import { buildEnttecMk2Frame, buildEnttecMk2InitFrames, buildEnttecProFrame, buildSerialDmxFrame } from '@shared/protocols'
import type { OutputSettings } from '@shared/types'

const execFileAsync = promisify(execFile)

/** Liệt kê các cổng USB / Serial hiện có trên macOS, Linux và Windows (không cần native C++ addon). */
export async function listSerialPorts(): Promise<string[]> {
  try {
    if (process.platform === 'darwin') {
      const entries = await fs.promises.readdir('/dev')
      return entries
        .filter((f) => /^cu\.(usb|SLAB|wchusb|FTDI)/i.test(f))
        .sort()
        .map((f) => `/dev/${f}`)
    }
    if (process.platform === 'linux') {
      const entries = await fs.promises.readdir('/dev')
      return entries
        .filter((f) => /^(ttyUSB|ttyACM)\d+/.test(f))
        .sort()
        .map((f) => `/dev/${f}`)
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames()'],
        { timeout: 3000 },
      )
      return stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
  } catch {
    /* ignore */
  }
  return []
}

/**
 * Driver USB / Serial DMX cho Enttec DMX USB Pro, Enttec Pro Mk2, và Generic Serial / RS-485.
 */
export class SerialDmxDriver implements OutputDriver {
  readonly id: OutputSettings['driver']
  private fd: number | null = null
  private winProc: ChildProcessWithoutNullStreams | null = null
  private writing = false
  private stopped = false

  constructor(
    private readonly cfg: OutputSettings,
    private readonly ev: DriverEvents,
  ) {
    this.id = cfg.driver
  }

  private baudRate(): number {
    if (this.cfg.baudRate && this.cfg.baudRate > 0) return this.cfg.baudRate
    return this.cfg.driver === 'serial' ? 250000 : 57600
  }

  private encodePacket(data: Uint8Array): Uint8Array {
    if (this.cfg.driver === 'enttec-pro') return buildEnttecProFrame(data)
    if (this.cfg.driver === 'enttec-mk2') return buildEnttecMk2Frame(data, this.cfg.enttecMk2Port ?? 1)
    return buildSerialDmxFrame(data, this.cfg.serialFormat ?? 'raw')
  }

  start(): void {
    this.stopped = false
    const portPath = this.cfg.serialPort?.trim()
    if (!portPath) {
      this.ev.onError(null)
      this.ev.onWarn('Chưa chọn cổng USB / Serial (vào Cài đặt DMX để chọn)')
      return
    }

    if (process.platform === 'win32') {
      this.startWindows(portPath, this.baudRate())
      return
    }
    void this.startPosix(portPath, this.baudRate())
  }

  private async startPosix(portPath: string, baud: number): Promise<void> {
    try {
      const flag = process.platform === 'darwin' ? '-f' : '-F'
      await execFileAsync('stty', [flag, portPath, String(baud), 'raw', '-echo', 'cs8', '-cstopb', '-parenb'])
      if (this.stopped) return
      const fd = await new Promise<number>((resolve, reject) => {
        fs.open(portPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK, (err, handle) => {
          if (err) reject(err)
          else resolve(handle)
        })
      })
      if (this.stopped) {
        fs.close(fd, () => {})
        return
      }
      this.fd = fd
      this.ev.onError(null)
      this.ev.onWarn(null)
      if (this.cfg.driver === 'enttec-mk2') {
        for (const frame of buildEnttecMk2InitFrames()) {
          this.writeRaw(frame)
        }
      }
      this.poll()
    } catch (err) {
      this.ev.onError(`Không mở được cổng ${portPath}: ${(err as Error).message}`)
    }
  }

  private startWindows(portPath: string, baud: number): void {
    try {
      const stopBits = this.cfg.driver === 'serial' && (this.cfg.serialFormat ?? 'raw') === 'raw' ? 'Two' : 'One'
      const script = [
        `$sp = New-Object System.IO.Ports.SerialPort('${portPath.replace(/'/g, "''")}', ${baud}, 'None', 8, '${stopBits}')`,
        '$sp.Open()',
        'while (($line = [Console]::In.ReadLine()) -ne $null) {',
        '  if ($line.Length -eq 0) { continue }',
        '  $b = [Convert]::FromBase64String($line)',
        '  $sp.Write($b, 0, $b.Length)',
        '}',
        '$sp.Close()',
      ].join('; ')
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.winProc = proc
      proc.stderr.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim()
        if (msg) this.ev.onError(`Lỗi Serial ${portPath}: ${msg}`)
      })
      proc.on('exit', (code) => {
        if (!this.stopped && code && code !== 0) {
          this.ev.onError(`Cổng Serial ${portPath} bị ngắt (code ${code})`)
        }
      })
      this.ev.onError(null)
      this.ev.onWarn(null)
      if (this.cfg.driver === 'enttec-mk2') {
        for (const frame of buildEnttecMk2InitFrames()) {
          this.writeRaw(frame)
        }
      }
      this.poll()
    } catch (err) {
      this.ev.onError(`Không mở được cổng ${portPath}: ${(err as Error).message}`)
    }
  }

  private writeRaw(packet: Uint8Array): void {
    if (this.winProc && !this.winProc.killed && this.winProc.stdin.writable) {
      this.winProc.stdin.write(`${Buffer.from(packet).toString('base64')}\n`)
      return
    }
    if (this.fd === null || this.writing) return
    this.writing = true
    const buf = Buffer.from(packet)
    fs.write(this.fd, buf, 0, buf.length, null, (err) => {
      this.writing = false
      if (err && !this.stopped) {
        this.ev.onError(`Gửi Serial DMX thất bại: ${err.message}`)
      }
    })
  }

  send(_net: number, _subUni: number, data: Uint8Array): void {
    if (this.fd === null && !this.winProc) return
    const pkt = this.encodePacket(data)
    this.writeRaw(pkt)
    const portPath = this.cfg.serialPort?.trim()
    if (portPath) {
      this.ev.onNode({
        ip: portPath,
        name:
          this.cfg.driver === 'enttec-pro'
            ? 'Enttec Pro'
            : this.cfg.driver === 'enttec-mk2'
              ? `Enttec Mk2 P${this.cfg.enttecMk2Port ?? 1}`
              : 'Serial DMX',
        longName: `${portPath} @ ${this.baudRate()} baud`,
        lastSeen: Date.now(),
      })
    }
  }

  poll(): void {
    const portPath = this.cfg.serialPort?.trim()
    if (!portPath || (this.fd === null && !this.winProc)) return
    this.ev.onNode({
      ip: portPath,
      name:
        this.cfg.driver === 'enttec-pro'
          ? 'Enttec Pro'
          : this.cfg.driver === 'enttec-mk2'
            ? `Enttec Mk2 P${this.cfg.enttecMk2Port ?? 1}`
            : 'Serial DMX',
      longName: `${portPath} @ ${this.baudRate()} baud`,
      lastSeen: Date.now(),
    })
  }

  stop(): void {
    this.stopped = true
    if (this.fd !== null) {
      const handle = this.fd
      this.fd = null
      fs.close(handle, () => {})
    }
    if (this.winProc) {
      try {
        this.winProc.stdin.end()
        this.winProc.kill()
      } catch {
        /* ignore */
      }
      this.winProc = null
    }
  }
}
