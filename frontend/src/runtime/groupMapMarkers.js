import * as THREE from 'three'

// Cartographic symbols represent location only; their height is NOT a fake
// production volume. At country scale use an abstract beacon. At region scale
// use a small isometric factory glyph so the map reads as a 3D site directory;
// it is deliberately generic and must never be mistaken for the live Unity hall.
export function createFactoryMapMarker(site, position, compact = false, { footprint = true, radiusScale = 1, beamScale = 1, primary = '#376ff0', tip = '#bbfff0' } = {}) {
  const root = new THREE.Group()
  const height = compact ? 4.2 : 23
  const radius = (compact ? 2.05 : 5.8) * radiusScale
  const primaryColor = new THREE.Color(primary)
  const tipColor = new THREE.Color(tip)
  if (site.runtime !== 'local') {
    primaryColor.lerp(new THREE.Color('#b168e0'), .42)
    tipColor.lerp(new THREE.Color('#eed3ff'), .35)
  }
  const accent = primaryColor.getHex()
  let bodyMaterial = null
  let glowMaterial = null
  let selected = false
  const pulseMaterials = []
  const pulse = (material, base, amplitude, speed = 1.25, phase = 0) => {
    pulseMaterials.push({ material, base, amplitude, speed, phase })
    return material
  }
  const animate = time => {
    const wave = value => 0.5 + 0.5 * Math.sin(time * value.speed + value.phase)
    for (const value of pulseMaterials) value.material.opacity = Math.min(1, value.base + wave(value) * value.amplitude + (selected ? 0.12 : 0))
    if (bodyMaterial) bodyMaterial.uniforms.time.value = time
    if (bodyMaterial) bodyMaterial.uniforms.selected.value = selected ? 1 : 0
    if (glowMaterial) glowMaterial.uniforms.time.value = time
    if (glowMaterial) glowMaterial.uniforms.selected.value = selected ? 1 : 0
  }
  const setSelected = value => {
    selected = Boolean(value)
    for (const item of pulseMaterials) item.material.opacity = Math.min(1, item.base + (selected ? 0.12 : 0))
    if (bodyMaterial) bodyMaterial.uniforms.selected.value = selected ? 1 : 0
    if (glowMaterial) glowMaterial.uniforms.selected.value = selected ? 1 : 0
  }

  if (compact) {
    const shell = new THREE.MeshStandardMaterial({
      color: site.runtime === 'local' ? 0x657187 : 0x746d83,
      roughness: 0.72,
      metalness: 0.16
    })
    const roof = new THREE.MeshStandardMaterial({
      color: site.runtime === 'local' ? 0x9ca8bd : 0xa89db7,
      roughness: 0.58,
      metalness: 0.2
    })
    const glass = new THREE.MeshStandardMaterial({
      color: site.runtime === 'local' ? 0x8bd6ed : 0xc6a9e8,
      emissive: site.runtime === 'local' ? 0x27708c : 0x67438b,
      emissiveIntensity: 0.32,
      roughness: 0.32,
      metalness: 0.12
    })
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a2437, roughness: 0.88, metalness: 0.05 })
    const detail = new THREE.MeshStandardMaterial({ color: 0x4d5a70, roughness: 0.78, metalness: 0.12 })
    const addBox = (size, point, material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
      mesh.position.set(...point)
      root.add(mesh)
      return mesh
    }

    // Compact, legible hall silhouette: loading bays on the front, roof lights,
    // and two small vents give the locator depth without implying real assets.
    const body = addBox([3.35, 1.55, 2.35], [0, 0.8, 0], shell)
    const top = addBox([3.55, 0.2, 2.55], [0, 1.66, 0], roof)
    const frontZ = 1.19
    addBox([0.48, 0.86, 0.055], [-1.02, 0.48, frontZ], dark)
    addBox([0.48, 0.86, 0.055], [1.02, 0.48, frontZ], dark)
    addBox([0.36, 0.44, 0.055], [0, 0.96, frontZ], glass)
    addBox([0.5, 0.07, 0.06], [0, 0.19, frontZ], detail)

    for (const x of [-1.05, 0, 1.05]) {
      const skylight = addBox([0.52, 0.075, 0.62], [x, 1.805, -0.26], glass)
      skylight.rotation.z = -0.035
    }
    for (const x of [-1.28, 1.28]) {
      const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.34, 10), detail)
      vent.position.set(x, 2.0, -0.78)
      root.add(vent)
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.045, 10), roof)
      cap.position.set(x, 2.19, -0.78)
      root.add(cap)
    }

    const edgeMaterial = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.68 })
    const bodyEdges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), edgeMaterial)
    bodyEdges.position.copy(body.position)
    root.add(bodyEdges)
    const roofEdges = new THREE.LineSegments(new THREE.EdgesGeometry(top.geometry), edgeMaterial)
    roofEdges.position.copy(top.position)
    root.add(roofEdges)

    const mastMaterial = pulse(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.8 }), 0.67, 0.16)
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.045, 1.62, 8), mastMaterial)
    mast.position.set(0, 3.12, 0)
    root.add(mast)
    const beaconMaterial = pulse(new THREE.MeshBasicMaterial({ color: site.runtime === 'local' ? 0xb8e8ff : 0xe0c3ff, transparent: true }), 0.72, 0.24, 1.7, 0.4)
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), beaconMaterial)
    beacon.position.set(0, 3.98, 0)
    root.add(beacon)

    for (let index = 0; index < 2; index++) {
      const baseOpacity = 0.2 - index * 0.055
      const ringMaterial = pulse(new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: baseOpacity, side: THREE.DoubleSide, depthWrite: false }), baseOpacity, 0.09, 1.05, index * 0.9)
      const ring = new THREE.Mesh(new THREE.RingGeometry(radius * (1.12 + index * 0.12), radius * (1.15 + index * 0.12), 64), ringMaterial)
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.025 + index * 0.012
      root.add(ring)
    }

    root.position.set(position[0], 0.68, -position[1])
    const anchor = new THREE.Vector3(position[0], height + 1.1, -position[1])
    root.userData.siteId = site.id
    for (const child of root.children) child.userData.siteId = site.id
    const pin = new THREE.Vector3(position[0], 0.68 + beacon.position.y, -position[1])
    return { root, anchor, pin, animate, setSelected }
  }

  const profile = Array.from({length:25}, (_,index) => {
    const t=index/24
    return new THREE.Vector2(radius*Math.pow(1-t,2.5)+.045,height*t)
  })
  const glowColor = primaryColor.clone()
  bodyMaterial = new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,side:THREE.DoubleSide,
    uniforms:{height:{value:height},time:{value:0},selected:{value:0},transitionOpacity:{value:1},bottom:{value:primaryColor},top:{value:tipColor}},
    vertexShader:'uniform float height; varying float level; varying vec3 viewNormal; varying vec3 viewDirection; void main(){level=clamp(position.y/height,0.0,1.0);vec4 viewPosition=modelViewMatrix*vec4(position,1.0);viewNormal=normalize(normalMatrix*normal);viewDirection=normalize(-viewPosition.xyz);gl_Position=projectionMatrix*viewPosition;}',
    fragmentShader:'uniform float time;uniform float selected;uniform float transitionOpacity;uniform vec3 bottom;uniform vec3 top;varying float level;varying vec3 viewNormal;varying vec3 viewDirection;void main(){float edge=pow(1.0-abs(dot(normalize(viewNormal),normalize(viewDirection))),2.2);float bands=pow(max(0.0,cos(level*140.0-time*.6)),28.0);float tip=pow(level,2.5);float breathe=.96+.04*sin(time*1.15);vec3 color=(mix(bottom,top,tip)+vec3(edge*.11+bands*.12+selected*.065))*breathe;float alpha=(.39+.24*tip+.26*edge+bands*.11+selected*.12)*smoothstep(0.0,.035,level)*breathe;gl_FragColor=vec4(color,alpha*transitionOpacity);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'
  })
  const body=new THREE.Mesh(new THREE.LatheGeometry(profile,40),bodyMaterial)
  body.userData.siteId=site.id
  root.add(body)
  // A single radial decal gives the beacon a footprint on the geographic map.
  // It is a location highlight, not a live state or an invented measurement.
  if (footprint) {
    glowMaterial = new THREE.ShaderMaterial({
      uniforms:{color:{value:glowColor},time:{value:0},selected:{value:0},transitionOpacity:{value:1}},
      transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
      vertexShader:'varying vec2 uvPosition;void main(){uvPosition=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:'uniform vec3 color;uniform float time;uniform float selected;uniform float transitionOpacity;varying vec2 uvPosition;void main(){float d=length(uvPosition-.5)*2.0;float core=pow(max(0.0,1.0-d),4.0);float haze=pow(max(0.0,1.0-d),1.8);float breathe=.88+.12*sin(time*1.1);gl_FragColor=vec4(color,(core*.22+haze*.095)*breathe*(1.0+selected*.65)*transitionOpacity);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'
    })
    const groundGlow=new THREE.Mesh(new THREE.PlaneGeometry(radius*7,radius*7),glowMaterial)
    groundGlow.rotation.x=-Math.PI/2
    groundGlow.position.y=.018
    root.add(groundGlow)
  }
  const beamMaterial = pulse(new THREE.MeshBasicMaterial({color:tipColor,transparent:true,opacity:.34,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide}), .27, .12, 1.1, .2)
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(.045*beamScale,.19*beamScale,height*.96,12,1,true),beamMaterial)
  beam.position.y=height*.48
  root.add(beam)
  if (footprint) for(let index=0;index<3;index++){
    const baseOpacity=.28-index*.075
    const ringMaterial=pulse(new THREE.MeshBasicMaterial({color:glowColor,transparent:true,opacity:baseOpacity,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}),baseOpacity,.12,1.05,index*.85)
    const ring=new THREE.Mesh(new THREE.RingGeometry(radius*(1+index*.24),radius*(1.035+index*.24),64),ringMaterial)
    ring.rotation.x=-Math.PI/2;ring.position.y=.035+index*.01;root.add(ring)
  }
  const beaconTip=new THREE.Mesh(new THREE.SphereGeometry(.16*Math.max(.32,beamScale),12,8),new THREE.MeshBasicMaterial({color:tipColor,transparent:true,opacity:.95,blending:THREE.AdditiveBlending,depthWrite:false}))
  beaconTip.position.y=height
  root.add(beaconTip)
  root.position.set(position[0],.72,-position[1])
  root.userData.siteId=site.id
  for(const child of root.children)child.userData.siteId=site.id
  return {root,anchor:new THREE.Vector3(position[0],height+1.1,-position[1]),pin:new THREE.Vector3(position[0],.72+height,-position[1]),animate,setSelected}
}
