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

const { AccessToken } = require('livekit-server-sdk')

const app = express()
app.use(express.json())

const bots = new Map()
const SAMPLE_RATE = 48000
const CHANNELS = 1
const FRAME_MS = 10
const FRAME_SIZE = Math.floor(SAMPLE_RATE * FRAME_MS / 1000)

function auth(req, res, next) {
  const authHeader = req.headers.authorization

  if (authHeader !== `Bearer ${process.env.BOT_SECRET}`) {
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

async function startMusic(roomName, trackUrl, trackName, requestedVolume) {
  await stopMusic(roomName)

  const room = new Room()

  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    {
      identity: `music-bot-${roomName}`,
      name: trackName || 'Background Music',
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

  const pcm = await convertToPCM(trackUrl)

  const source = new AudioSource(SAMPLE_RATE, CHANNELS)
  const track = LocalAudioTrack.createAudioTrack('music', source)

  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE

  await room.localParticipant.publishTrack(track, options)

  let playing = true
  let paused = false
  let cleanupStarted = false

  const cleanup = async () => {
    if (cleanupStarted) return
    cleanupStarted = true

    playing = false

    try {
      await track.close()
    } catch (error) {
      console.error('Failed to close music track:', error)
    }

    try {
      await room.disconnect()
    } catch (error) {
      console.error('Failed to disconnect music bot:', error)
    }
  }

  const bot = {
    stop: cleanup,
    status: 'playing',
    trackName: trackName || 'Background Music',
    identity: `music-bot-${roomName}`,
    startedAt: new Date().toISOString(),
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    frameMs: FRAME_MS,
    pcmSamples: pcm.length,
    durationSeconds: pcm.length / SAMPLE_RATE,
    framesSent: 0,
    samplesSent: 0,
    lastFrameAt: null,
    error: null,
    volume: clampVolume(requestedVolume),
    paused: false,
    pause: () => {
      paused = true
      bot.paused = true
      bot.status = 'paused'
    },
    resume: () => {
      paused = false
      bot.paused = false
      bot.status = 'playing'
    },
    setVolume: (nextVolume) => {
      bot.volume = clampVolume(nextVolume)
      return bot.volume
    },
  }

  bots.set(roomName, bot)

  const playLoop = async () => {
    let position = 0

    try {
      while (playing) {
        if (paused) {
          const silenceFrame = new Int16Array(FRAME_SIZE)

          await source.captureFrame(
            new AudioFrame(silenceFrame, SAMPLE_RATE, CHANNELS, silenceFrame.length)
          )

          bot.framesSent += 1
          bot.samplesSent += silenceFrame.length
          bot.lastFrameAt = new Date().toISOString()

          await new Promise((r) => setTimeout(r, FRAME_MS))
          continue
        }

        if (position >= pcm.length) position = 0

        const frame = new Int16Array(FRAME_SIZE)
        const sourceSamples = pcm.subarray(position, position + FRAME_SIZE)

        for (let index = 0; index < sourceSamples.length; index += 1) {
          frame[index] = Math.max(
            -32768,
            Math.min(32767, Math.round(sourceSamples[index] * bot.volume))
          )
        }

        await source.captureFrame(
          new AudioFrame(frame, SAMPLE_RATE, CHANNELS, frame.length)
        )

        position += FRAME_SIZE
        bot.framesSent += 1
        bot.samplesSent += frame.length
        bot.lastFrameAt = new Date().toISOString()

        await new Promise((r) => setTimeout(r, FRAME_MS))
      }
    } catch (error) {
      bot.status = 'error'
      bot.error = error.message
      console.error('Music playback loop failed:', error)
    } finally {
      await cleanup()

      if (bots.get(roomName) === bot) {
        bots.delete(roomName)
      }
    }
  }

  playLoop()

  return {
    status: 'playing',
    identity: `music-bot-${roomName}`,
    trackName: bot.trackName,
    sampleRate: bot.sampleRate,
    frameMs: bot.frameMs,
    durationSeconds: bot.durationSeconds,
    volume: bot.volume,
    paused: bot.paused,
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
      if (!roomName) {
        return res.status(400).json({ error: 'roomName is required' })
      }

      await stopMusic(roomName)
      return res.json({ success: true })
    }

    if (action === 'status') {
      if (!roomName) {
        return res.status(400).json({ error: 'roomName is required' })
      }

      const bot = bots.get(roomName)

      return res.json({
        success: true,
        status: bot?.status ?? 'stopped',
        identity: bot?.identity ?? null,
        trackName: bot?.trackName ?? null,
        startedAt: bot?.startedAt ?? null,
        sampleRate: bot?.sampleRate ?? null,
        channels: bot?.channels ?? null,
        frameMs: bot?.frameMs ?? null,
        pcmSamples: bot?.pcmSamples ?? null,
        durationSeconds: bot?.durationSeconds ?? null,
        framesSent: bot?.framesSent ?? 0,
        samplesSent: bot?.samplesSent ?? 0,
        lastFrameAt: bot?.lastFrameAt ?? null,
        error: bot?.error ?? null,
        volume: bot?.volume ?? null,
        paused: bot?.paused ?? false,
      })
    }

    if (action === 'pause' || action === 'resume' || action === 'volume') {
      if (!roomName) {
        return res.status(400).json({ error: 'roomName is required' })
      }

      const bot = bots.get(roomName)
      if (!bot) {
        return res.status(404).json({ error: 'No music is playing in this room' })
      }

      if (action === 'pause') bot.pause()
      if (action === 'resume') bot.resume()
      if (action === 'volume') bot.setVolume(volume)

      return res.json({
        success: true,
        status: bot.status,
        trackName: bot.trackName,
        volume: bot.volume,
        paused: bot.paused,
      })
    }

    res.status(400).json({ error: 'Invalid action' })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: error.message })
  }
})

app.listen(process.env.PORT, () => {
  console.log(`Bot running on ${process.env.PORT}`)
})
