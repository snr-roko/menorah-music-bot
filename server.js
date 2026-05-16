require('dotenv').config()

const express = require('express')
const ffmpeg = require('fluent-ffmpeg')

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
const FRAME_SAMPLES = FRAME_SIZE * CHANNELS
const FRAME_BYTES = FRAME_SAMPLES * 2
const MUSIC_MAX_BITRATE = 192000
const DEFAULT_VOLUME = 0.35
const AUDIO_QUEUE_MS = 1000

const SILENCE_FRAME = new Int16Array(FRAME_SAMPLES)

function auth(req, res, next) {
  if (req.headers.authorization !== `Bearer ${process.env.BOT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

const clampVolume = (volume) => {
  const parsed = Number(volume)
  if (!Number.isFinite(parsed)) return DEFAULT_VOLUME
  return Math.max(0.05, Math.min(1, parsed))
}

const applyVolumeToFrame = (buffer, bytesRead, volume, outputFrame) => {
  outputFrame.fill(0)

  const inputSamples = new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(bytesRead / 2)
  )

  for (let i = 0; i < inputSamples.length; i++) {
    outputFrame[i] = Math.max(
      -32768,
      Math.min(32767, Math.round(inputSamples[i] * volume))
    )
  }
}

const createToken = async (roomName, trackName) => {
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

  return token.toJwt()
}

const createPCMStream = (trackUrl) => {
  const command = ffmpeg(trackUrl)
    .inputOptions([
      '-reconnect 1',
      '-reconnect_streamed 1',
      '-reconnect_delay_max 2',
    ])
    .noVideo()
    .audioFrequency(SAMPLE_RATE)
    .audioChannels(CHANNELS)
    .audioCodec('pcm_s16le')
    .format('s16le')
    .outputOptions(['-loglevel error'])

  const stream = command.pipe()
  return { command, stream }
}

async function stopMusic(roomName) {
  const bot = bots.get(roomName)
  if (!bot) return
  await bot.stop()
  bots.delete(roomName)
}

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    activeBots: bots.size,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    timestamp: new Date().toISOString(),
  })
})

async function startMusic(roomName, trackUrl, trackName, requestedVolume) {
  await stopMusic(roomName)

  const room = new Room()
  const jwt = await createToken(roomName, trackName)
  await room.connect(process.env.LIVEKIT_URL, jwt)

  const source = new AudioSource(SAMPLE_RATE, CHANNELS, AUDIO_QUEUE_MS)
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
  let ffmpegCommand = null
  const outputFrame = new Int16Array(FRAME_SAMPLES)
  const frameBuffer = Buffer.alloc(FRAME_BYTES)

  const bot = {
    stop: cleanup,
    status: 'starting',
    trackName: trackName || 'Background Music',
    identity: `music-bot-${roomName}`,
    startedAt: new Date().toISOString(),
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    maxBitrate: MUSIC_MAX_BITRATE,
    frameMs: FRAME_MS,
    pcmSamples: null,
    durationSeconds: null,
    framesSent: 0,
    lastFrameAt: null,
    error: null,
    volume: clampVolume(requestedVolume),
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
      return this.volume
    },
  }

  async function cleanup() {
    if (cleanupStarted) return
    cleanupStarted = true
    playing = false

    try { if (ffmpegCommand) ffmpegCommand.kill('SIGKILL') } catch {}
    try { source.clearQueue() } catch {}
    try { await track.close() } catch {}
    try { await room.disconnect() } catch {}
  }

  const sendSilence = async () => {
    await source.captureFrame(
      new AudioFrame(SILENCE_FRAME, SAMPLE_RATE, CHANNELS, FRAME_SIZE)
    )
    bot.framesSent++
    bot.lastFrameAt = Date.now()
  }

  const streamOnce = async () => {
    const { command, stream } = createPCMStream(trackUrl)
    ffmpegCommand = command

    let pending = Buffer.alloc(0)
    let hasAudio = false

    command.on('error', (error) => {
      if (playing) {
        bot.status = 'error'
        bot.error = error.message
        console.error(`[${roomName}] ffmpeg error:`, error.message)
      }
    })

    for await (const chunk of stream) {
      if (!playing) break

      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk

      while (pending.length >= FRAME_BYTES && playing) {
        if (paused) {
          await sendSilence()
          continue
        }

        pending.copy(frameBuffer, 0, 0, FRAME_BYTES)
        pending = pending.subarray(FRAME_BYTES)
        applyVolumeToFrame(frameBuffer, FRAME_BYTES, bot.volume, outputFrame)

        await source.captureFrame(
          new AudioFrame(outputFrame, SAMPLE_RATE, CHANNELS, FRAME_SIZE)
        )

        if (!hasAudio) {
          hasAudio = true
          bot.status = 'playing'
          bot.error = null
        }

        bot.framesSent++
        bot.lastFrameAt = Date.now()
      }
    }
  }

  const playLoop = async () => {
    try {
      while (playing) {
        bot.status = bot.paused ? 'paused' : 'starting'
        await streamOnce()
      }
    } catch (error) {
      if (playing) {
        bot.status = 'error'
        bot.error = error.message
        console.error(`[${roomName}] playback loop error:`, error.message)
      }
    } finally {
      await cleanup()
      if (bots.get(roomName) === bot) bots.delete(roomName)
    }
  }

  bots.set(roomName, bot)
  playLoop()

  return {
    status: bot.status,
    identity: bot.identity,
    trackName: bot.trackName,
    sampleRate: bot.sampleRate,
    channels: bot.channels,
    maxBitrate: bot.maxBitrate,
    frameMs: bot.frameMs,
    durationSeconds: bot.durationSeconds,
    volume: bot.volume,
  }
}

app.post('/music', auth, async (req, res) => {
  try {
    const { action, roomName, trackUrl, trackName, volume } = req.body

    if (!roomName) return res.status(400).json({ error: 'roomName is required' })

    if (action === 'play') {
      if (!trackUrl) {
        return res.status(400).json({ error: 'roomName and trackUrl are required' })
      }
      const result = await startMusic(roomName, trackUrl, trackName, volume)
      return res.json({ success: true, ...result })
    }

    if (action === 'stop') {
      await stopMusic(roomName)
      return res.json({ success: true })
    }

    if (action === 'status') {
      const bot = bots.get(roomName)
      return res.json({
        success: true,
        status: bot?.status ?? 'stopped',
        identity: bot?.identity ?? null,
        trackName: bot?.trackName ?? null,
        startedAt: bot?.startedAt ?? null,
        sampleRate: bot?.sampleRate ?? null,
        channels: bot?.channels ?? null,
        maxBitrate: bot?.maxBitrate ?? null,
        frameMs: bot?.frameMs ?? null,
        pcmSamples: bot?.pcmSamples ?? null,
        durationSeconds: bot?.durationSeconds ?? null,
        framesSent: bot?.framesSent ?? 0,
        lastFrameAt: bot?.lastFrameAt ?? null,
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
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: error.message })
  }
})

process.on('SIGTERM', async () => {
  console.log('SIGTERM received - stopping all bots')
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
