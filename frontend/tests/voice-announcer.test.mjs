import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceAnnouncer } from '../src/runtime/VoiceAnnouncer.js'
import { installBrowser } from './helpers.mjs'

test('dispose stops an active audio file, clears its handlers and prevents TTS fallback', async t => {
    const { browser, replace } = installBrowser(t)
    const files = []
    let ttsCalls = 0
    browser.speechSynthesis = { speak: () => { ttsCalls += 1 }, getVoices: () => [], cancel() {} }
    replace('Audio', class {
        constructor(url) { this.url = url; files.push(this) }
        play() { return Promise.resolve() }
        pause() { this.paused = true }
        removeAttribute(name) { this.removed = name }
    })
    const announcer = createVoiceAnnouncer()
    const playback = announcer.preview({ mode: 'file', audio_url: '/uploads/alarm.wav', text: 'fallback' })
    assert.equal(files.length, 1)
    announcer.dispose()
    await playback
    assert.equal(files[0].paused, true)
    assert.equal(files[0].onended, null)
    assert.equal(files[0].onerror, null)
    assert.equal(files[0].removed, 'src')
    assert.equal(announcer.playbackCancels.size, 0)
    assert.equal(ttsCalls, 0)
})

test('muting stops active system speech and settles its promise immediately', async t => {
    const { browser, replace } = installBrowser(t)
    let cancellations = 0
    browser.speechSynthesis = { speak() {}, getVoices: () => [], cancel: () => { cancellations += 1 } }
    replace('SpeechSynthesisUtterance', class { constructor(text) { this.text = text } })
    const announcer = createVoiceAnnouncer()
    const playback = announcer.preview({ mode: 'tts', text: 'alarm' })
    const rejection = assert.rejects(playback, /语音播放已停止/)
    announcer.setMuted(true)
    await rejection
    assert.equal(cancellations, 1)
    assert.equal(announcer.playbackCancels.size, 0)
    announcer.dispose()
})
