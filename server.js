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
      .inputFormat('mp3')
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('s16le')
      .pipe(output)
  })
}

async function stopMusic(roomName) {
  const bot = bots.get(roomName)
  if (!bot) return

  bot.stop()
  bots.delete(roomName)
}

async function startMusic(roomName, trackUrl, trackName) {
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

  const source = new AudioSource(16000, 1)
  const track = LocalAudioTrack.createAudioTrack('music', source)

  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE

  await room.localParticipant.publishTrack(track, options)

  let playing = true

  bots.set(roomName, {
    stop: () => {
      playing = false
    },
  })

  let position = 0
  const FRAME_SIZE = 1600

  while (playing) {
    if (position >= pcm.length) position = 0

    const frame = pcm.subarray(position, position + FRAME_SIZE)

    await source.captureFrame(
      new AudioFrame(frame, 16000, 1, frame.length)
    )

    position += FRAME_SIZE

    await new Promise((r) => setTimeout(r, 100))
  }

  await track.close()
  await room.disconnect()
}

app.post('/music', auth, async (req, res) => {
  try {
    const { action, roomName, trackUrl, trackName } = req.body

    if (action === 'play') {
      if (!roomName || !trackUrl) {
        return res.status(400).json({ error: 'roomName and trackUrl are required' })
      }

      startMusic(roomName, trackUrl, trackName).catch((error) => {
        console.error('Music playback failed:', error)
        bots.delete(roomName)
      })

      return res.json({ success: true })
    }

    if (action === 'stop') {
      if (!roomName) {
        return res.status(400).json({ error: 'roomName is required' })
      }

      await stopMusic(roomName)
      return res.json({ success: true })
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
