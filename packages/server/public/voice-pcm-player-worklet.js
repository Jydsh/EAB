/**
 * EAB 连续语音播放器：把 24kHz 单声道 s16le PCM 放进一个持续运行的环形队列，
 * 由音频线程直接输出。相比每个 HTTP 块新建 AudioBufferSourceNode，能避免块边界
 * 反复起停造成的咔哒声，也不会因为主线程在渲染 Markdown 时抖动而卡音频。
 */
class EabVoicePcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options?.processorOptions || {}
    this.sourceRate = Number(opts.sourceRate) || 24_000
    this.prebufferFrames = Math.max(0, Math.round((Number(opts.prebufferSeconds) || 0.8) * this.sourceRate))
    this.fadeFrames = Math.max(1, Math.round((Number(opts.fadeSeconds) || 0.006) * this.sourceRate))
    this.queue = []
    this.readOffset = 0
    this.queuedFrames = 0
    this.started = false
    this.playing = false
    this.fadeInRemaining = 0
    this.releaseRemaining = 0
    this.lastSample = 0
    this.endPending = false
    this.drainedSent = true
    this.port.onmessage = (event) => this.onMessage(event.data || {})
  }

  onMessage(message) {
    if (message.type === 'pcm') {
      const pcm = new Int16Array(message.buffer)
      if (!pcm.length) return
      const floats = new Float32Array(pcm.length)
      for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768
      this.queue.push(floats)
      this.queuedFrames += floats.length
      this.endPending = false
      this.drainedSent = false
      // 上一句刚在块边界整块播完时，下一块本来要补一小段淡出；
      // 新数据既然到了，就直接从淡入重新接上，避免旧尾巴和新句子重叠。
      this.releaseRemaining = 0
      if (this.started && !this.playing) this.fadeInRemaining = this.fadeFrames
      return
    }
    if (message.type === 'reset') {
      this.queue.length = 0
      this.readOffset = 0
      this.queuedFrames = 0
      this.started = false
      this.playing = false
      this.fadeInRemaining = 0
      this.releaseRemaining = 0
      this.lastSample = 0
      this.endPending = false
      this.drainedSent = true
      return
    }
    if (message.type === 'end') {
      // 本句没有更多数据；队列播空后进入短淡出，避免最后半个采样硬切。
      this.endPending = true
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0]
    if (!output) return true
    if (!this.started) {
      if (this.queuedFrames < this.prebufferFrames) {
        output.fill(0)
        return true
      }
      this.started = true
      this.playing = true
      this.fadeInRemaining = this.fadeFrames
      this.drainedSent = false
      this.port.postMessage({ type: 'started' })
    }

    // 队列恰好在一个 128 帧块的末尾播空时，上一块没有空间做淡出；
    // 这里用下一块补上 6ms 衰减，避免最后一个采样直接跳到 0 造成“咔”一声。
    if (!this.playing && this.releaseRemaining > 0) {
      const release = Math.min(this.releaseRemaining, output.length)
      for (let index = 0; index < release; index += 1) {
        output[index] = this.lastSample * ((this.releaseRemaining - index) / this.fadeFrames)
      }
      if (release < output.length) output.fill(0, release)
      this.releaseRemaining -= release
      if (this.releaseRemaining <= 0) this.lastSample = 0
      if (this.started && this.queuedFrames <= 0 && this.endPending && !this.drainedSent) {
        this.drainedSent = true
        this.port.postMessage({ type: 'drained' })
      }
      return true
    }

    let written = 0
    while (written < output.length) {
      if (!this.queue.length) break
      const chunk = this.queue[0]
      if (this.readOffset >= chunk.length) {
        this.queue.shift()
        this.readOffset = 0
        continue
      }
      let sample = chunk[this.readOffset]
      this.readOffset += 1
      this.queuedFrames -= 1
      if (this.fadeInRemaining > 0) {
        sample *= 1 - this.fadeInRemaining / this.fadeFrames
        this.fadeInRemaining -= 1
      }
      output[written] = sample
      this.lastSample = sample
      written += 1
    }

    if (written < output.length) {
      if (this.playing) {
        // 队列暂时空了：用最后一段采样做 6ms 淡出，然后输出静音。
        // 下一句数据到达时会重新淡入；这样断流时也不会在边界上爆一下。
        const remaining = output.length - written
        const release = Math.min(this.fadeFrames, remaining)
        for (let index = 0; index < release; index += 1) {
          output[written + index] = this.lastSample * (1 - (index + 1) / release)
        }
        if (release < remaining) output.fill(0, written + release)
        this.playing = false
        this.releaseRemaining = 0
        this.port.postMessage({ type: 'underrun' })
      } else {
        output.fill(0, written)
      }
    } else if (this.queuedFrames <= 0) {
      // 刚好在本块最后一个采样播完；下一块再补 6ms 淡出，避免硬切到静音。
      this.playing = false
      this.releaseRemaining = this.fadeFrames
    }

    if (this.started && !this.playing && this.queuedFrames <= 0 && this.endPending && !this.drainedSent) {
      this.drainedSent = true
      this.port.postMessage({ type: 'drained' })
    }
    return true
  }
}

registerProcessor('eab-voice-pcm-player', EabVoicePcmPlayer)
