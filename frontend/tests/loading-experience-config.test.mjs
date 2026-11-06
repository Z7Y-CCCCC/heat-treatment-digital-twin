import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LOADING_EXPERIENCE, normalizeLoadingExperience } from '../src/runtime/loadingExperienceConfig.js'

test('loading experience accepts a quiet preset and valid branding', () => {
  const config = normalizeLoadingExperience(JSON.stringify({preset:'quiet',title:'正在进入集团地图',accent:'#ABCDEF'}))
  assert.equal(config.preset, 'quiet')
  assert.equal(config.title, '正在进入集团地图')
  assert.equal(config.accent, '#2563eb')
  assert.equal(config.background, DEFAULT_LOADING_EXPERIENCE.background)
})

test('loading experience rejects unsafe colors and unknown schemes', () => {
  const config = normalizeLoadingExperience({preset:'script',background:'url(javascript:bad)'})
  assert.equal(config.preset, 'interactive')
  assert.equal(config.background, DEFAULT_LOADING_EXPERIENCE.background)
})

test('loading offers exactly blue-white and the previous dark palette; old dark settings stay dark', () => {
  assert.equal(DEFAULT_LOADING_EXPERIENCE.background, '#f5f7fb')
  assert.equal(DEFAULT_LOADING_EXPERIENCE.accent, '#2563eb')
  for (const background of ['#28282b', '#29292c']) {
    const legacy = normalizeLoadingExperience({ background, accent: '#A8C3B1', title: '自定义标题' })
    assert.equal(legacy.theme, 'dark')
    assert.equal(legacy.background, '#28282b')
    assert.equal(legacy.accent, '#a8c3b1')
    assert.equal(legacy.title, '自定义标题')
  }
  const custom = normalizeLoadingExperience({ background: '#123456', accent: '#abcdef' })
  assert.equal(custom.theme, 'light')
  assert.equal(custom.background, '#f5f7fb')
  assert.equal(custom.accent, '#2563eb')
  assert.equal(normalizeLoadingExperience({ theme: 'light', background: '#28282b' }).background, '#f5f7fb')
  assert.equal(normalizeLoadingExperience({ theme: 'dark' }).background, '#28282b')
})
