import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LOADING_EXPERIENCE, normalizeLoadingExperience } from '../src/runtime/loadingExperienceConfig.js'

test('loading experience accepts a quiet preset and valid branding', () => {
  const config = normalizeLoadingExperience(JSON.stringify({preset:'quiet',title:'正在进入集团地图',accent:'#ABCDEF'}))
  assert.equal(config.preset, 'quiet')
  assert.equal(config.title, '正在进入集团地图')
  assert.equal(config.accent, '#abcdef')
  assert.equal(config.background, DEFAULT_LOADING_EXPERIENCE.background)
})

test('loading experience rejects unsafe colors and unknown schemes', () => {
  const config = normalizeLoadingExperience({preset:'script',background:'url(javascript:bad)'})
  assert.equal(config.preset, 'interactive')
  assert.equal(config.background, DEFAULT_LOADING_EXPERIENCE.background)
})
