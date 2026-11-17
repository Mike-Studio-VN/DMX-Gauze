import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import type { DriverEvents, OutputDriver } from '@shared/drivers'
import { buildEnttecMk2Frame, buildEnttecMk2InitFrames, buildEnttecProFrame, buildSerialDmxFrame } from '@shared/protocols'
import type { OutputSettings } from '@shared/types'

const execFileAsync = promisify(execFile)
const STOP_GRACE_MS = 1500

// Hàng rào giải phóng theo cổng vật lý: đảm bảo driver cũ đóng fd / thoát tiến trình Windows
// xong trước khi driver mới mở lại đúng cổng COM/tty đó khi reconfigure nhanh.
const portReleaseQueue = new Map<string, Promise<void>>()

function normalizePortKey(portPath: string): string {
  const trimmed = portPath.trim()
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

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
  private winStopTimer: ReturnType<typeof setTimeout> | null = null
  private posixStopTimer: ReturnType<typeof setTimeout> | null = null
  private releaseGate: { promise: Promise<void>; resolve: () => void } | null = null
  private writing = false
  private closing = false
  private stopped = false
  private controlQueue: Buffer[] = []
  private pendingDataFrame: Buffer | null = null
  private pendingRawLen = 0

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

  private acquirePortGate(portPath: string): Promise<void> {
    const key = normalizePortKey(portPath)
    const prev = portReleaseQueue.get(key) ?? Promise.resolve()
    let resolveGate!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    let resolved = false
    this.releaseGate = {
      promise,
      resolve: () => {
        if (resolved) return
        resolved = true
        resolveGate()
      },
    }
    const chained = prev.then(() => promise)
    portReleaseQueue.set(key, chained)
    void chained.finally(() => {
      if (portReleaseQueue.get(key) === chained) portReleaseQueue.delete(key)
    })
    return prev
  }

  private resolvePortGate(): void {
    this.releaseGate?.resolve()
  }

  start(): void {
    this.closing = false
    this.stopped = false
    this.writing = false
    this.controlQueue = []
    this.pendingDataFrame = null
    this.pendingRawLen = 0
    const portPath = this.cfg.serialPort?.trim()
    if (!portPath) {
      this.ev.onError(null)
      this.ev.onWarn('Chưa chọn cổng USB / Serial (vào Cài đặt DMX để chọn)')
      return
    }

    const waitPrev = this.acquirePortGate(portPath)
    if (process.platform === 'win32') {
      void this.startWindows(portPath, this.baudRate(), waitPrev)
      return
    }
    void this.startPosix(portPath, this.baudRate(), waitPrev)
  }

  private async startPosix(portPath: string, baud: number, waitPrev: Promise<void>): Promise<void> {
    try {
      await waitPrev
      if (this.stopped || this.closing) {
        this.stopped = true
        this.resolvePortGate()
        return
      }
      const flag = process.platform === 'darwin' ? '-f' : '-F'
      await execFileAsync('stty', [flag, portPath, String(baud), 'raw', '-echo', 'cs8', '-cstopb', '-parenb'])
      if (this.stopped || this.closing) {
        this.stopped = true
        this.resolvePortGate()
        return
      }
      const fd = await new Promise<number>((resolve, reject) => {
        fs.open(portPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK, (err, handle) => {
          if (err) reject(err)
          else resolve(handle)
        })
      })
      if (this.stopped || this.closing) {
        this.stopped = true
        fs.close(fd, () => this.resolvePortGate())
        return
      }
      this.fd = fd
      this.ev.onError(null)
      this.ev.onWarn(null)
      if (this.cfg.driver === 'enttec-mk2') {
        for (const frame of buildEnttecMk2InitFrames()) {
          this.enqueueControl(frame)
        }
      }
      this.poll()
    } catch (err) {
      if (!this.closing && !this.stopped) {
        this.ev.onError(`Không mở được cổng ${portPath}: ${(err as Error).message}`)
      }
      this.resolvePortGate()
    }
  }

  private async startWindows(portPath: string, baud: number, waitPrev: Promise<void>): Promise<void> {
    try {
      await waitPrev
      if (this.stopped || this.closing) {
        this.stopped = true
        this.resolvePortGate()
        return
      }
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
        if (msg && !this.closing && !this.stopped) this.ev.onError(`Lỗi Serial ${portPath}: ${msg}`)
      })
      proc.on('error', (err) => {
        if (this.winStopTimer) {
          clearTimeout(this.winStopTimer)
          this.winStopTimer = null
        }
        if (this.winProc === proc) this.winProc = null
        if (!this.closing && !this.stopped) {
          this.ev.onError(`Không mở được cổng ${portPath}: ${err.message}`)
        }
        this.resolvePortGate()
      })
      proc.on('exit', (code) => {
        if (this.winStopTimer) {
          clearTimeout(this.winStopTimer)
          this.winStopTimer = null
        }
        if (this.winProc === proc) this.winProc = null
        if (!this.stopped && !this.closing && code && code !== 0) {
          this.ev.onError(`Cổng Serial ${portPath} bị ngắt (code ${code})`)
        }
        this.resolvePortGate()
      })
      if (this.stopped || this.closing) {
        this.stopWindowsProc(proc)
        return
      }
      this.ev.onError(null)
      this.ev.onWarn(null)
      if (this.cfg.driver === 'enttec-mk2') {
        for (const frame of buildEnttecMk2InitFrames()) {
          this.enqueueControl(frame)
        }
      }
      this.poll()
    } catch (err) {
      if (!this.closing && !this.stopped) {
        this.ev.onError(`Không mở được cổng ${portPath}: ${(err as Error).message}`)
      }
      this.resolvePortGate()
    }
  }

  private stopWindowsProc(proc: ChildProcessWithoutNullStreams): void {
    try {
      proc.stdin.end()
    } catch {
      /* ignore */
    }
    if (this.winStopTimer) clearTimeout(this.winStopTimer)
    this.winStopTimer = setTimeout(() => {
      try {
        if (this.winProc === proc && !proc.killed) proc.kill()
      } catch {
        this.resolvePortGate()
      }
    }, STOP_GRACE_MS)
    this.winStopTimer.unref?.()
  }

  private enqueueControl(packet: Uint8Array): void {
    if (this.winProc && !this.winProc.killed && this.winProc.stdin.writable) {
      this.winProc.stdin.write(`${Buffer.from(packet).toString('base64')}\n`)
      return
    }
    if (this.stopped || this.closing || this.fd === null) return
    this.controlQueue.push(Buffer.from(packet))
    this.drainPosixQueue()
  }

  private writeRawData(data: Uint8Array): void {
    if (this.winProc && !this.winProc.killed && this.winProc.stdin.writable) {
      const pkt = this.encodePacket(data)
      this.winProc.stdin.write(`${Buffer.from(pkt).toString('base64')}\n`)
      return
    }
    if (this.stopped || this.closing || this.fd === null) return
    // Giữ nguyên độ dài tối đa của khung xoá kênh cao chưa ghi ra cổng nếu tick mới gửi khung ngắn hơn.
    const rawLen = Math.max(data.length, this.pendingRawLen)
    let payload = data
    if (rawLen > data.length) {
      const padded = new Uint8Array(rawLen)
      padded.set(data)
      payload = padded
    }
    this.pendingRawLen = rawLen
    this.pendingDataFrame = Buffer.from(this.encodePacket(payload))
    this.drainPosixQueue()
  }

  private drainPosixQueue(): void {
    if (this.stopped || this.fd === null || this.writing) return
    const next = this.controlQueue.shift() ?? this.takePendingDataFrame()
    if (!next) {
      if (this.closing) this.finishClosePosix()
      return
    }
    this.writeBufferPosix(next)
  }

  private takePendingDataFrame(): Buffer | null {
    const buf = this.pendingDataFrame
    this.pendingDataFrame = null
    this.pendingRawLen = 0
    return buf
  }

  private finishClosePosix(): void {
    if (this.posixStopTimer) {
      clearTimeout(this.posixStopTimer)
      this.posixStopTimer = null
    }
    this.stopped = true
    this.controlQueue = []
    this.pendingDataFrame = null
    this.pendingRawLen = 0
    if (this.fd !== null) {
      const handle = this.fd
      this.fd = null
      fs.close(handle, () => {
        this.resolvePortGate()
      })
    } else {
      this.resolvePortGate()
    }
  }

  private writeBufferPosix(buf: Buffer): void {
    if (this.stopped || this.fd === null) return
    const handle = this.fd
    this.writing = true
    fs.write(handle, buf, 0, buf.length, null, (err, written = buf.length) => {
      this.writing = false
      if (err) {
        this.controlQueue = []
        this.pendingDataFrame = null
        this.pendingRawLen = 0
        if (this.closing) {
          this.finishClosePosix()
        } else if (!this.stopped) {
          this.ev.onError(`Gửi Serial DMX thất bại: ${err.message}`)
        }
        return
      }
      if (this.stopped || this.fd === null) return
      if (written > 0 && written < buf.length) {
        this.writeBufferPosix(buf.subarray(written))
        return
      }
      this.drainPosixQueue()
    })
  }

  send(_net: number, _subUni: number, data: Uint8Array): void {
    if (this.stopped || this.closing || (this.fd === null && !this.winProc)) return
    this.writeRawData(data)
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
    if (!portPath || this.stopped || this.closing || (this.fd === null && !this.winProc)) return
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
    if (this.stopped || this.closing) return
    this.closing = true
    if (this.winProc) {
      this.stopped = true
      this.stopWindowsProc(this.winProc)
      return
    }
    if (this.fd === null) {
      this.stopped = true
      this.controlQueue = []
      this.pendingDataFrame = null
      this.pendingRawLen = 0
      this.resolvePortGate()
      return
    }
    // Nếu không có khung DMX/zero nào cần xả nốt, bỏ qua control frame khởi tạo chưa bắt đầu ghi.
    if (this.pendingDataFrame === null) {
      this.controlQueue = []
    }
    if (!this.writing && this.controlQueue.length === 0 && !this.pendingDataFrame) {
      this.finishClosePosix()
      return
    }
    this.posixStopTimer = setTimeout(() => {
      if (!this.stopped) this.finishClosePosix()
    }, STOP_GRACE_MS)
    this.posixStopTimer.unref?.()
  }
}
