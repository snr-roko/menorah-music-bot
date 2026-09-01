require('dotenv').config()

const express = require('express')
const ffmpeg = require('fluent-ffmpeg')

const {
  Room,
  RoomEvent,
  AudioSource,
  LocalAudioTrack,
  AudioFrame,
  TrackPublishOptions,
} = require('@livekit/rtc-node')
const { AudioEncoding } = require('@livekit/rtc-ffi-bindings')
const { AccessToken } = require('livekit-server-sdk')

const app = express()
app.use(express.json())

const bots = new Map()
const SAMPLE_RATE = 48000
const CHANNELS = 2
const FRAME_MS = 20
const FRAME_SIZE = Math.floor(SAMPLE_RATE * FRAME_MS / 1000)
const FRAME_SAMPLES = FRAME_SIZE * CHANNELS
const FRAME_BYTES = FRAME_SAMPLES * 2
const MUSIC_MAX_BITRATE = 96000
const DEFAULT_VOLUME = 0.4
const MUSIC_GAIN_CEILING = 0.35
const AUDIO_QUEUE_MS = 2500
// How long a bot may sit connected-but-idle (warmed, or soft-stopped with
// nothing playing) before it's torn down to free the LiveKit connection and
// this box's resources. A forgotten "warm" call, or a session that never
// sends an explicit shutdown (app crash, force-quit), self-heals within
// this window instead of leaking a connection forever.
const IDLE_DISCONNECT_MS = 10 * 60 * 1000

const SILENCE_FRAME = new Int16Array(FRAME_SAMPLES)
// Reused for every silence frame sent while paused, across every bot - its
// data never changes, so there's no reason to allocate a fresh AudioFrame
// wrapper each time (previously happened up to 50x/sec per paused bot).
// AudioFrame's constructor just stores a reference to the array it's given
// (confirmed against the LiveKit node-sdks source), never copies it, so
// sharing one instance across concurrent bots reading the same immutable
// silence is safe.
const SILENCE_AUDIO_FRAME = new AudioFrame(SILENCE_FRAME, SAMPLE_RATE, CHANNELS, FRAME_SIZE)

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

const volumeToGain = (volume) => {
  return Math.max(0.03, clampVolume(volume) * MUSIC_GAIN_CEILING)
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

const createToken = async (roomName) => {
  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    {
      identity: `music-bot-${roomName}`,
      name: 'Background Music',
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
      '-nostdin',
      '-hide_banner',
      '-reconnect 1',
      '-reconnect_streamed 1',
      '-reconnect_at_eof 1',
      '-reconnect_delay_max 2',
      '-rw_timeout 15000000',
      '-fflags +discardcorrupt',
      '-err_detect ignore_err',
      // Skips ffmpeg's default full-file probing pass before it starts
      // decoding. For a plain mp3/m4a/wav coming from Supabase Storage the
      // format is unambiguous from a small header read, so this cuts real
      // wall-clock time off "how long until the first frame is ready"
      // without sacrificing correct format detection.
      '-analyzeduration 0',
      '-probesize 32768',
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

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    activeBots: bots.size,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    timestamp: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
//
// A bot now has two layers, kept deliberately separate:
//
//   1. The LiveKit connection (room + published track) - expensive to set
//      up: a WebSocket connect, ICE/DTLS negotiation, and track publish
//      negotiation, commonly several hundred ms to a few seconds depending
//      on network conditions. The previous version tore this down and
//      rebuilt it on *every* play call - including switching from one
//      track to another mid-session - which is the main reason starting
//      music was slow every single time, not just the first time.
//
//   2. The ffmpeg decode + frame loop for whichever track is currently
//      selected - cheap and fast to start/stop by comparison.
//
// connectBot() only ever does #1, and only when there isn't already a live
// connection for this room. play/stop/pause/resume/volume all reuse it.
// The connection is only actually torn down by shutdownBot() - called
// explicitly when a live session ends, automatically after an idle
// timeout as a safety net, or automatically if LiveKit itself disconnects
// the room (e.g. the app force-closes it server-side via deleteRoom - the
// previous version had no listener for this at all, so that scenario left
// ffmpeg and the frame loop running forever against a dead connection).

// Tracks a connection attempt that's currently in flight, per room. Without
// this, a warm() call and a play() landing close enough together (a fast
// tap, or just ordinary network jitter) would both see "no bot connected
// yet" and each start their own room.connect() under the same bot
// identity - two real LiveKit connections racing each other, with no
// guarantee which one actually ends up in `bots`. Every caller now awaits
// the same single attempt instead.
const connectingBots = new Map()

async function connectBot(roomName) {
  const existingBot = bots.get(roomName)
  if (existingBot && existingBot.connected) return existingBot

  const inFlight = connectingBots.get(roomName)
  if (inFlight) return inFlight

  const attempt = (async () => {
    const room = new Room()
    const jwt = await createToken(roomName)
    await room.connect(process.env.LIVEKIT_URL, jwt)

    const source = new AudioSource(SAMPLE_RATE, CHANNELS, AUDIO_QUEUE_MS)
    const track = LocalAudioTrack.createAudioTrack('background-music', source)
    const options = new TrackPublishOptions()
    options.audioEncoding = new AudioEncoding({ maxBitrate: BigInt(MUSIC_MAX_BITRATE) })
    options.dtx = false
    options.red = true

    await room.localParticipant.publishTrack(track, options)

    const bot = {
      room,
      source,
      track,
      connected: true,
      playing: false,
      paused: false,
      status: 'idle',
      trackName: null,
      identity: `music-bot-${roomName}`,
      startedAt: new Date().toISOString(),
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      maxBitrate: MUSIC_MAX_BITRATE,
      frameMs: FRAME_MS,
      durationSeconds: null,
      framesSent: 0,
      lastFrameAt: null,
      error: null,
      volume: clampVolume(DEFAULT_VOLUME),
      gain: volumeToGain(DEFAULT_VOLUME),
      ffmpegCommand: null,
      idleTimer: null,
      // Bumped every time playback is (re)started or stopped. Lets a
      // still-unwinding ffmpeg/frame loop from a *previous* play call
      // notice it's stale and exit cleanly instead of racing a newer one -
      // this replaces the old single `playing` boolean now that a bot's
      // connection outlives any single track.
      generation: 0,
      pause() {
        this.paused = true
        this.status = 'paused'
      },
      resume() {
        this.paused = false
        this.status = 'playing'
      },
      setVolume(v) {
        this.volume = clampVolume(v)
        this.gain = volumeToGain(v)
        return this.volume
      },
    }

    room.on(RoomEvent.Disconnected, () => {
      console.warn(`[${roomName}] Room disconnected by server, cleaning up bot`)
      void shutdownBot(roomName)
    })

    bots.set(roomName, bot)
    armIdleTimer(bot, roomName)
    return bot
  })()

  connectingBots.set(roomName, attempt)

  try {
    return await attempt
  } catch (error) {
    // Nothing was stored in `bots` on failure, so there's nothing to clean
    // up here - the next call (a retry, or Play itself if this was a warm
    // that failed silently) will just attempt a fresh connection.
    console.error(`[${roomName}] connectBot failed:`, error.message)
    throw error
  } finally {
    // Whether this attempt succeeded or failed, it's no longer in flight -
    // a failure must not permanently block future retries.
    connectingBots.delete(roomName)
  }
}

function armIdleTimer(bot, roomName) {
  clearIdleTimer(bot)
  bot.idleTimer = setTimeout(() => {
    console.log(`[${roomName}] Idle for ${IDLE_DISCONNECT_MS / 60000}min, shutting down`)
    void shutdownBot(roomName)
  }, IDLE_DISCONNECT_MS)
}

function clearIdleTimer(bot) {
  if (bot.idleTimer) {
    clearTimeout(bot.idleTimer)
    bot.idleTimer = null
  }
}

// Soft stop: ffmpeg stops, the room connection and published track stay up.
// The next Play (any track) skips straight to spawning ffmpeg.
async function stopTrack(roomName) {
  const bot = bots.get(roomName)
  if (!bot) return

  bot.generation++
  bot.playing = false
  bot.paused = false
  bot.status = 'idle'
  bot.trackName = null

  try { if (bot.ffmpegCommand) bot.ffmpegCommand.kill('SIGKILL') } catch {}
  bot.ffmpegCommand = null
  try { bot.source.clearQueue() } catch {}

  armIdleTimer(bot, roomName)
}

// Hard stop: fully disconnects from LiveKit and frees this bot's resources.
// Call this when music is truly done for the session - not on every Stop
// tap in the UI.
async function shutdownBot(roomName) {
  const bot = bots.get(roomName)
  if (!bot) return
  bots.delete(roomName)

  bot.generation++
  clearIdleTimer(bot)

  try { if (bot.ffmpegCommand) bot.ffmpegCommand.kill('SIGKILL') } catch {}
  try { bot.source.clearQueue() } catch {}
  try { await bot.track.close() } catch {}
  try { await bot.room.disconnect() } catch {}
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
//
// Turns arbitrarily-sized ffmpeg stdout chunks into fixed FRAME_BYTES-sized
// frames without allocating a new buffer on essentially every chunk. The
// previous version did `pending = Buffer.concat([pending, chunk])` on
// almost every incoming chunk - a fresh allocate-and-copy several times a
// second, for the entire duration of every track. That's a steady drip of
// garbage during playback, and the GC pauses it causes can stall the event
// loop for a tick right when a frame is due - exactly the kind of jitter
// real-time 20ms-cadence audio can't absorb without sounding scratchy, and
// exactly the kind of thing VM sizing can't fix. Instead, chunks are
// memcpy'd into one fixed-size scratch buffer allocated once per track;
// frames are read off the front by advancing a cursor, not by resizing the
// buffer. The buffer is only ever compacted (unread bytes slid back to
// offset 0) when its tail runs out of room, which is an in-place memmove,
// not an allocation - growth only happens in the pathological case of a
// single incoming chunk bigger than the whole scratch buffer, which should
// not occur in practice given the size chosen below.
class FrameAccumulator {
  constructor(frameBytes, scratchBytes = Math.max(frameBytes * 32, 1 << 20)) {
    this.frameBytes = frameBytes
    this.scratch = Buffer.alloc(scratchBytes)
    this.readOffset = 0
    this.writeOffset = 0
  }

  push(chunk) {
    let offset = 0
    while (offset < chunk.length) {
      if (this.readOffset === this.writeOffset) {
        // Nothing unread - cheapest case, just reset to the front.
        this.readOffset = 0
        this.writeOffset = 0
      } else if (this.writeOffset === this.scratch.length) {
        // Tail is full but there's still unread data behind readOffset -
        // slide it down to reclaim the space already given back.
        this.scratch.copy(this.scratch, 0, this.readOffset, this.writeOffset)
        this.writeOffset -= this.readOffset
        this.readOffset = 0
      }

      let space = this.scratch.length - this.writeOffset
      if (space === 0) {
        // Whole scratch buffer is still full of unread data and this one
        // incoming chunk still doesn't fit - vanishingly unlikely at these
        // buffer sizes, but grow rather than stall forever.
        const grown = Buffer.alloc(this.scratch.length * 2)
        this.scratch.copy(grown, 0, this.readOffset, this.writeOffset)
        this.writeOffset -= this.readOffset
        this.readOffset = 0
        this.scratch = grown
        space = this.scratch.length - this.writeOffset
      }

      const toCopy = Math.min(space, chunk.length - offset)
      chunk.copy(this.scratch, this.writeOffset, offset, offset + toCopy)
      this.writeOffset += toCopy
      offset += toCopy
    }
  }

  get available() {
    return this.writeOffset - this.readOffset
  }

  // Copies the next full frame into `dest` and advances the read cursor
  // past it. Returns false (and leaves the cursor untouched) if less than
  // one frame is currently buffered.
  takeFrame(dest) {
    if (this.available < this.frameBytes) return false
    this.scratch.copy(dest, 0, this.readOffset, this.readOffset + this.frameBytes)
    this.readOffset += this.frameBytes
    return true
  }

  // Discards the next full frame without copying it anywhere - used while
  // paused, where the decoded audio is thrown away in favor of silence.
  skipFrame() {
    if (this.available < this.frameBytes) return false
    this.readOffset += this.frameBytes
    return true
  }
}

const sendSilence = async (bot) => {
  await bot.source.captureFrame(SILENCE_AUDIO_FRAME)
  bot.framesSent++
  bot.lastFrameAt = Date.now()
}

async function streamOnce(bot, roomName, trackUrl, generation) {
  const { command, stream } = createPCMStream(trackUrl)
  bot.ffmpegCommand = command

  let hasAudio = false
  const outputFrame = new Int16Array(FRAME_SAMPLES)
  const frameBuffer = Buffer.alloc(FRAME_BYTES)
  // Reused for every frame of this track instead of constructing a new
  // AudioFrame wrapper on every one of them (up to 50x/sec). Safe to
  // reuse: AudioFrame's constructor just stores a reference to the array
  // it's given, never copies it (confirmed against the LiveKit node-sdks
  // source) - and every captureFrame() call below is awaited to
  // completion before outputFrame is mutated again for the next frame, so
  // there's never a frame in flight while its data changes underneath it.
  // That's the same guarantee the original code already relied on, since
  // outputFrame itself was already a single buffer mutated in place every
  // iteration - only the AudioFrame wrapper around it was being
  // reallocated needlessly.
  const frame = new AudioFrame(outputFrame, SAMPLE_RATE, CHANNELS, FRAME_SIZE)
  const accumulator = new FrameAccumulator(FRAME_BYTES)

  command.on('error', (error) => {
    if (bot.generation === generation) {
      bot.status = 'error'
      bot.error = error.message
      console.error(`[${roomName}] ffmpeg error:`, error.message)
    }
  })

  for await (const chunk of stream) {
    if (bot.generation !== generation) break

    accumulator.push(chunk)

    while (bot.generation === generation) {
      if (bot.paused) {
        if (!accumulator.skipFrame()) break
        await sendSilence(bot)
        continue
      }

      if (!accumulator.takeFrame(frameBuffer)) break
      applyVolumeToFrame(frameBuffer, FRAME_BYTES, bot.gain, outputFrame)

      await bot.source.captureFrame(frame)

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

async function playLoop(bot, roomName, trackUrl, generation) {
  try {
    while (bot.generation === generation) {
      await streamOnce(bot, roomName, trackUrl, generation)
      if (bot.generation !== generation) break
      // ffmpeg's stream ended (track finished) - loop the same track,
      // matching the previous behavior.
    }
  } catch (error) {
    if (bot.generation === generation) {
      bot.status = 'error'
      bot.error = error.message
      console.error(`[${roomName}] playback loop error:`, error.message)
    }
  }
}

async function startMusic(roomName, trackUrl, trackName, requestedVolume) {
  const bot = await connectBot(roomName)

  // Stop whatever's currently playing (if anything) before starting the
  // new track. This only touches ffmpeg - the room/track connection this
  // bot already has is reused, not rebuilt.
  bot.generation++
  try { if (bot.ffmpegCommand) bot.ffmpegCommand.kill('SIGKILL') } catch {}
  bot.ffmpegCommand = null
  try { bot.source.clearQueue() } catch {}

  clearIdleTimer(bot)

  bot.playing = true
  bot.paused = false
  bot.status = 'starting'
  bot.trackName = trackName || 'Background Music'
  bot.error = null
  if (requestedVolume !== undefined) bot.setVolume(requestedVolume)

  const generation = bot.generation
  playLoop(bot, roomName, trackUrl, generation).finally(() => {
    // Only re-arm the idle timer if nothing newer has taken over meanwhile.
    if (bot.generation === generation && bots.get(roomName) === bot) {
      armIdleTimer(bot, roomName)
    }
  })

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
    gain: bot.gain,
  }
}

app.post('/music', auth, async (req, res) => {
  try {
    const { action, roomName, trackUrl, trackName, volume } = req.body

    if (!roomName) return res.status(400).json({ error: 'roomName is required' })

    if (action === 'warm') {
      const bot = await connectBot(roomName)
      return res.json({ success: true, status: bot.status })
    }

    if (action === 'play') {
      if (!trackUrl) {
        return res.status(400).json({ error: 'roomName and trackUrl are required' })
      }
      const result = await startMusic(roomName, trackUrl, trackName, volume)
      return res.json({ success: true, ...result })
    }

    if (action === 'stop') {
      await stopTrack(roomName)
      return res.json({ success: true })
    }

    if (action === 'shutdown') {
      await shutdownBot(roomName)
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
        durationSeconds: bot?.durationSeconds ?? null,
        framesSent: bot?.framesSent ?? 0,
        lastFrameAt: bot?.lastFrameAt ?? null,
        volume: bot?.volume ?? null,
        gain: bot?.gain ?? null,
        paused: bot?.paused ?? false,
        error: bot?.error ?? null,
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      })
    }

    if (action === 'pause') {
      const bot = bots.get(roomName)
      if (!bot || !bot.playing) return res.status(404).json({ error: 'No music playing' })
      bot.pause()
      return res.json({ success: true, status: bot.status })
    }

    if (action === 'resume') {
      const bot = bots.get(roomName)
      if (!bot || !bot.playing) return res.status(404).json({ error: 'No music playing' })
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
  await Promise.all([...bots.keys()].map(shutdownBot))
  process.exit(0)
})

process.on('SIGINT', async () => {
  await Promise.all([...bots.keys()].map(shutdownBot))
  process.exit(0)
})

app.listen(process.env.PORT, () => {
  console.log(`Bot running on port ${process.env.PORT}`)
})
