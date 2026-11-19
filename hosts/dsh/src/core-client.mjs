// Repo Tutor Core 的 JSON-RPC 客户端：spawn 一个 core 进程，逐行收发。
// 这是 DSH adapter 与 C++ Core 之间的唯一通道；Tutor 领域状态都在 core 里。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class CoreClient {
  #core
  #lines
  #nextId = 1
  #pending = new Map()

  constructor(exePath, { onStderr } = {}) {
    this.#core = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })

    this.#core.on('error', (error) => this.#failAll(error))
    this.#core.on('exit', () => this.#failAll(new Error('core process exited')))
    this.#core.stderr.on('data', (chunk) => {
      onStderr?.(chunk.toString())
    })

    this.#lines = createInterface({ input: this.#core.stdout, crlfDelay: Infinity })
    this.#lines.on('line', (line) => this.#onLine(line))
  }

  // 发一个 JSON-RPC 请求，返回 result。
  request(method, params = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#core.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  close() {
    this.#core.stdin.end()
    this.#core.kill()
  }

  #onLine(line) {
    if (line.trim() === '') {
      return
    }

    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    const pending = this.#pending.get(message.id)
    if (pending === undefined) {
      return
    }
    this.#pending.delete(message.id)

    if (message.error !== undefined) {
      const error = new Error(message.error.message)
      error.code = message.error.code
      pending.reject(error)
      return
    }
    pending.resolve(message.result)
  }

  #failAll(error) {
    for (const { reject } of this.#pending.values()) {
      reject(error)
    }
    this.#pending.clear()
  }
}
