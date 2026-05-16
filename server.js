require('dotenv').config()

const express = require('express')
const ffmpeg = require('fluent-ffmpeg')
const { Readable, PassThrough } = require('stream')

const {
  Room,
  AudioSource,
  LocalAudioTrack,
  AudioFrame,
  TrackPublishOptions,
  TrackSource,
} = require('@livekit/rtc-node')
const { AudioEncoding } = require('@livekit/rtc-ffi-bindings')
const { AccessToken } = require('livekit-server-sdk')

const app = express()
app.use(express.json())

const bots = new Map()
const SAMPLE_RATE = 48000
const CHANNELS = 2
const FRAME_MS = 10
const FRAME_SIZE = Math.floor(SAMPLE_RATE * FRAME_MS / 1000)
const MUSIC_MAX_BITRATE = 192000

// Pre-allocate ONE frame buffer and ONE silence buffer
// reuse them every iteration instead of allocating new ones each time
// This eliminates 100 allocations per second — the biggest GC pressure source
const REUSABLE_FRAME = new Int16Array(FRAME_SIZE * CHANNELS)
const SILENCE_FRAME = new Int16Array(FRAME_SIZE * CHANNELS)
// SILENCE_FRAME is all zeros by default — correct for silence

function auth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${process.env.BOT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

async function convertToPCM(trackUrl) {
  const response = await fetch(trackUrl)
  if (!response.ok) {
    throw new Error(`Failed to download track: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  return new Promise((resolve, reject) => {
    const chunks = []
    const input = Readable.from(buffer)
    const output = new PassThrough()

    output.on('data', (chunk) => chunks.push(chunk))
    output.on('end', () => {
      const finalBuffer = Buffer.concat(chunks)
      // Use subarray not slice — documented by LiveKit to avoid undefined behaviour
      const pcm = new Int16Array(
        finalBuffer.buffer,
        finalBuffer.byteOffset,
        finalBuffer.byteLength / 2
      )
      resolve(pcm)
    })
    output.on('error', reject)

    ffmpeg(input)
      .audioFrequency(SAMPLE_RATE)
      .audioChannels(CHANNELS)
      .audioCodec('pcm_s16le')
      .format('s16le')
      .on('error', reject)
      .pipe(output)
  })
}

async function stopMusic(roomName) {
  const bot = bots.get(roomName)
  if (!bot) return
  await bot.stop()
  bots.delete(roomName)
}

const clampVolume = (volume) => {
  const parsed = Number(volume)
  if (!Number.isFinite(parsed)) return 0.35
  return Math.max(0.05, Math.min(1, parsed))
}

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    activeBots: bots.size,
    uptimeSeconds: Math.round(process.uptime()),
    // Report actual memory usage so you can monitor it externally
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    timestamp: new Date().toISOString(),
  })
})

async function startMusic(roomName, trackUrl, trackName, requestedVolume) {
  await stopMusic(roomName)

  const room = new Room()

  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    {
      identity: `music-bot-${roomName}`,
      name: trackName || 'Background Music',
      ttl: '8h',
    }
  )

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: false,
  })

  const jwt = await token.toJwt()
  await room.connect(process.env.LIVEKIT_URL, jwt)

  // Download and convert before publishing
  // If this fails, room is disconnected cleanly before any track is published
  let pcm
  try {
    pcm = await convertToPCM(trackUrl)
  } catch (err) {
    await room.disconnect()
    throw err
  }

  const source = new AudioSource(SAMPLE_RATE, CHANNELS)
  const track = LocalAudioTrack.createAudioTrack('background-music', source)

  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_SCREENSHARE_AUDIO
  options.audioEncoding = new AudioEncoding({ maxBitrate: BigInt(MUSIC_MAX_BITRATE) })
  options.dtx = false
  options.red = true

  await room.localParticipant.publishTrack(track, options)

  let playing = true
  let paused = false
  let cleanupStarted = false

  const cleanup = async () => {
    if (cleanupStarted) return
    cleanupStarted = true
    playing = false

    // Clear the source queue before closing
    // prevents the captureFrame promise from hanging
    try { source.clearQueue() } catch {}
    try { await track.close() } catch {}
    try { await room.disconnect() } catch {}

    // Explicitly null out pcm reference so GC can collect it
    // This is the key memory fix — the large buffer gets released
    pcm = null
  }

  const volume = clampVolume(requestedVolume)

  const bot = {
    stop: cleanup,
    status: 'playing',
    trackName: trackName || 'Background Music',
    identity: `music-bot-${roomName}`,
    startedAt: new Date().toISOString(),
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    maxBitrate: MUSIC_MAX_BITRATE,
    frameMs: FRAME_MS,
    pcmSamples: pcm.length,
    durationSeconds: pcm.length / (SAMPLE_RATE * CHANNELS),
    framesSent: 0,
    lastFrameAt: null,
    error: null,
    volume,
    paused: false,
    pause() {
      paused = true
      this.paused = true
      this.status = 'paused'
    },
    resume() {
      paused = false
      this.paused = false
      this.status = 'playing'
    },
    setVolume(v) {
      this.volume = clampVolume(v)
      volume = this.volume
      // update the closure variable used by the loop
    },
  }

  bots.set(roomName, bot)

  const playLoop = async () => {
    let position = 0

    try {
      while (playing) {
        if (paused) {
          // Reuse the pre-allocated silence frame — no allocation
          await source.captureFrame(
            new AudioFrame(SILENCE_FRAME, SAMPLE_RATE, CHANNELS, FRAME_SIZE)
          )
          bot.framesSent++
          bot.lastFrameAt = Date.now()
          await new Promise(r => setTimeout(r, FRAME_MS))
          continue
        }

        // Check pcm is still available (cleanup may have nulled it)
        if (!pcm) break

        if (position >= pcm.length) position = 0

        const end = Math.min(position + FRAME_SIZE * CHANNELS, pcm.length)
        const sourceSamples = pcm.subarray(position, end)

        // Reuse the pre-allocated frame buffer — no allocation per frame
        // Fill only the portion we have, rest stays as previous values
        // which is fine since we pad with silence below
        const len = sourceSamples.length
        for (let i = 0; i < len; i++) {
          REUSABLE_FRAME[i] = Math.max(
            -32768,
            Math.min(32767, Math.round(sourceSamples[i] * bot.volume))
          )
        }
        // Zero-pad if the last frame is smaller than FRAME_SIZE * CHANNELS
        if (len < REUSABLE_FRAME.length) {
          REUSABLE_FRAME.fill(0, len)
        }

        await source.captureFrame(
          new AudioFrame(REUSABLE_FRAME, SAMPLE_RATE, CHANNELS, FRAME_SIZE)
        )

        position += len
        bot.framesSent++
        bot.lastFrameAt = Date.now()

        await new Promise(r => setTimeout(r, FRAME_MS))
      }
    } catch (err) {
      bot.status = 'error'
      bot.error = err.message
      console.error(`[${roomName}] Playback loop error:`, err.message)
    } finally {
      await cleanup()
      if (bots.get(roomName) === bot) bots.delete(roomName)
    }
  }

  // Start loop without awaiting — it runs in background
  playLoop()

  return {
    status: 'playing',
    identity: bot.identity,
    trackName: bot.trackName,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    maxBitrate: MUSIC_MAX_BITRATE,
    frameMs: FRAME_MS,
    durationSeconds: bot.durationSeconds,
    volume: bot.volume,
  }
}

app.post('/music', auth, async (req, res) => {
  try {
    const { action, roomName, trackUrl, trackName, volume } = req.body

    if (action === 'play') {
      if (!roomName || !trackUrl) {
        return res.status(400).json({ error: 'roomName and trackUrl are required' })
      }
      const result = await startMusic(roomName, trackUrl, trackName, volume)
      return res.json({ success: true, ...result })
    }

    if (action === 'stop') {
      if (!roomName) return res.status(400).json({ error: 'roomName is required' })
      await stopMusic(roomName)
      return res.json({ success: true })
    }

    if (action === 'status') {
      if (!roomName) return res.status(400).json({ error: 'roomName is required' })
      const bot = bots.get(roomName)
      return res.json({
        success: true,
        status: bot?.status ?? 'stopped',
        trackName: bot?.trackName ?? null,
        framesSent: bot?.framesSent ?? 0,
        lastFrameAt: bot?.lastFrameAt ?? null,
        durationSeconds: bot?.durationSeconds ?? null,
        volume: bot?.volume ?? null,
        paused: bot?.paused ?? false,
        error: bot?.error ?? null,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      })
    }

    if (action === 'pause') {
      const bot = bots.get(roomName)
      if (!bot) return res.status(404).json({ error: 'No music playing' })
      bot.pause()
      return res.json({ success: true, status: bot.status })
    }

    if (action === 'resume') {
      const bot = bots.get(roomName)
      if (!bot) return res.status(404).json({ error: 'No music playing' })
      bot.resume()
      return res.json({ success: true, status: bot.status })
    }

    if (action === 'volume') {
      const bot = bots.get(roomName)
      if (!bot) return res.status(404).json({ error: 'No music playing' })
      bot.setVolume(volume)
      return res.json({ success: true, volume: bot.volume })
    }

    return res.status(400).json({ error: 'Invalid action' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Graceful shutdown — clean up all bots before process exits
// This prevents dangling LiveKit connections on deploy/restart
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — stopping all bots')
  await Promise.all([...bots.keys()].map(stopMusic))
  process.exit(0)
})

process.on('SIGINT', async () => {
  await Promise.all([...bots.keys()].map(stopMusic))
  process.exit(0)
})

app.listen(process.env.PORT, () => {
  console.log(`Bot running on port ${process.env.PORT}`)
})