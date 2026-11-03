import test from 'node:test'
import assert from 'node:assert/strict'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three'
import { applyHallPresentation } from '../src/runtime/factoryHallPresentation.js'

test('hall walls/roof become faint, do not cast solid shadows or consume device rays; floors and shared device materials remain unchanged', () => {
  const source = new MeshStandardMaterial({ color: '#333333' }), hall = new Group()
  const wall = new Mesh(new BoxGeometry(10, 10, 1), source), roof = wall.clone(), floor = wall.clone()
  wall.name = 'wall'; roof.name = 'roof'; floor.name = 'hall_floor'
  hall.add(wall, roof, floor)
  const device = new Mesh(new BoxGeometry(), source)
  applyHallPresentation(hall)
  assert.equal(wall.material.opacity, .1)
  assert.equal(wall.material.depthWrite, false)
  assert.equal(wall.castShadow, false)
  assert.equal(wall.material, roof.material, 'one presentation clone per source material')
  assert.equal(floor.material, source)
  assert.equal(source.opacity, 1)
  assert.equal(device.material.opacity, 1)
  assert.equal(source.transparent, false)
  const ray = new Raycaster(new Vector3(0, 0, -10), new Vector3(0, 0, 1))
  hall.updateMatrixWorld(true)
  assert.equal(ray.intersectObject(hall, true).length, 0)
})
