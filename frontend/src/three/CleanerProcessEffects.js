import * as THREE from 'three'
import { CLEANER_EFFECT_NODES, cleanerProcessLayout } from './cleanerProcessLayout.js'

const fraction = value => value - Math.floor(value)
const point = values => new THREE.Vector3(...values)

function particles(count, color, size = 18) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage))
    const material = new THREE.ShaderMaterial({
        uniforms: { tint: { value: new THREE.Color(color) }, size: { value: size } },
        vertexShader: 'uniform float size; void main(){ vec4 p=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*p; gl_PointSize=clamp(size/max(.1,-p.z),2.,12.); }',
        fragmentShader: 'uniform vec3 tint; void main(){ float d=length(gl_PointCoord-.5)*2.; if(d>1.) discard; gl_FragColor=vec4(tint,(1.-d*d)*.8); }',
        transparent: true, depthWrite: false
    })
    const mesh = new THREE.Points(geometry, material)
    mesh.frustumCulled = false
    return mesh
}

function updateParticles(mesh, sample) {
    const positions = mesh.geometry.attributes.position
    for (let i = 0; i < positions.count; i++) {
        const p = sample(i)
        positions.setXYZ(i, p.x, p.y, p.z)
    }
    positions.needsUpdate = true
}

export class CleanerProcessEffects {
    constructor(scene, furnace) {
        this.root = new THREE.Group()
        this.root.name = 'cleaner_process_effects'
        scene.add(this.root)
        furnace.updateMatrixWorld(true)
        this.layout = cleanerProcessLayout(name => {
            const object = furnace.getObjectByName(name)
            return object ? new THREE.Box3().setFromObject(object) : null
        })
        const { chamber, fan, jets } = this.layout
        this.center = chamber.getCenter(new THREE.Vector3())
        this.size = chamber.getSize(new THREE.Vector3())
        this.water = new THREE.Mesh(new THREE.BoxGeometry(this.size.x, 1, this.size.z),
            new THREE.MeshStandardMaterial({ color: '#20b6df', transparent: true, opacity: .18, roughness: .2, depthWrite: false, side: THREE.DoubleSide }))
        this.surface = new THREE.Mesh(new THREE.PlaneGeometry(this.size.x, this.size.z),
            new THREE.MeshStandardMaterial({ color: '#5cd4ee', transparent: true, opacity: .48, roughness: .18, metalness: .2, depthWrite: false, side: THREE.DoubleSide }))
        this.surface.rotation.x = -Math.PI / 2
        this.root.add(this.water, this.surface)
        this.rings = Array.from({ length: 4 }, () => {
            const ring = new THREE.Mesh(new THREE.RingGeometry(.93, 1, 64),
                new THREE.MeshBasicMaterial({ color: '#b3f8ff', transparent: true, opacity: .5, depthWrite: false, side: THREE.DoubleSide }))
            ring.rotation.x = -Math.PI / 2
            this.root.add(ring)
            return ring
        })
        this.sprayLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(jets.flatMap(jet => [jet.start, jet.end])),
            new THREE.LineBasicMaterial({ color: '#31bbef', transparent: true, opacity: .5, depthWrite: false }))
        this.sprayParticles = particles(240, '#70d8ff', 23)
        this.bubbles = particles(130, '#c7fbff', 14)
        this.droplets = particles(65, '#52bce5', 17)
        const fanCenter = fan.getCenter(new THREE.Vector3())
        this.airPaths = [-.24, 0, .24].map(z => new THREE.CatmullRomCurve3([
            new THREE.Vector3(fanCenter.x, fan.min.y + .05, fanCenter.z + z),
            new THREE.Vector3(this.center.x, chamber.max.y - .08, this.center.z + z),
            new THREE.Vector3(chamber.max.x - .12, chamber.min.y + .35, this.center.z + z)
        ]))
        this.airLines = this.airPaths.map(curve => {
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(30)),
                new THREE.LineDashedMaterial({ color: '#90e8ee', dashSize: .07, gapSize: .055, transparent: true, opacity: .65, depthWrite: false }))
            line.computeLineDistances()
            this.root.add(line)
            return line
        })
        this.air = particles(72, '#d8ffff', 22)
        this.root.add(this.sprayLines, this.sprayParticles, this.bubbles, this.droplets, this.air)
        this.fillFlow = this.makeFlow(this.layout.fillPath, '#29b9f2')
        this.drainFlow = this.makeFlow(this.layout.drainPath, '#687ff0')
        this.highlightGroups = [
            this.highlights(furnace, CLEANER_EFFECT_NODES.heaters, '#eaa34f', 'heat'),
            this.highlights(furnace, CLEANER_EFFECT_NODES.ultrasonic, '#45c7d8', 'ultrasonic'),
            this.highlights(furnace, [CLEANER_EFFECT_NODES.fan], '#48c6c7', 'blow')
        ]
        this.apply(null)
    }

    highlights(furnace, names, color, key) {
        const entries = []
        for (const name of names) furnace.getObjectByName(name)?.traverse(mesh => {
            if (!mesh.isMesh) return
            const original = mesh.material
            const cloned = (Array.isArray(original) ? original : [original]).map(material => material.clone())
            mesh.material = Array.isArray(original) ? cloned : cloned[0]
            entries.push({ mesh, original, cloned, bases: cloned.map(material => ({ emissive: material.emissive?.clone(), intensity: material.emissiveIntensity,
                opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite })) })
        })
        return { entries, color: new THREE.Color(color), key, active: null }
    }

    makeFlow(vertices, color) {
        const group = new THREE.Group()
        const curve = new THREE.CatmullRomCurve3(vertices)
        const pipe = new THREE.Mesh(new THREE.TubeGeometry(curve, 36, .012, 6, false),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .5, depthWrite: false }))
        const dots = particles(16, color, 30)
        const arrows = Array.from({ length: 3 }, () => new THREE.Mesh(new THREE.ConeGeometry(.035, .10, 8),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .8 })))
        group.add(pipe, dots, ...arrows)
        this.root.add(group)
        return { group, curve, dots, arrows }
    }

    setCutaway(enabled) {
        // The CAD's second ultrasonic plate surrounds the working chamber.
        // Expose its interior together with the shell without moving the plate.
        for (const group of this.highlightGroups.filter(group => group.key === 'ultrasonic')) {
            for (const entry of group.entries) entry.cloned.forEach((material, i) => {
                const base = entry.bases[i]
                material.transparent = enabled || base.transparent
                material.opacity = enabled ? .2 : base.opacity
                material.depthWrite = enabled ? false : base.depthWrite
                material.needsUpdate = true
            })
        }
    }

    apply(state) {
        this.root.visible = !!state
        for (const group of this.highlightGroups) {
            const active = !!state?.[group.key]
            if (group.active === active) continue
            group.active = active
            for (const entry of group.entries) entry.cloned.forEach((material, i) => {
                if (!material.emissive) return
                material.emissive.copy(active ? group.color : entry.bases[i].emissive)
                material.emissiveIntensity = active ? .65 : entry.bases[i].intensity
            })
        }
        if (!state) return
        const time = state.time || 0
        const level = THREE.MathUtils.clamp(Number(state.level) || 0, 0, 1)
        const { chamber, jets } = this.layout
        const height = this.size.y * level
        const waterY = chamber.min.y + height
        this.water.visible = this.surface.visible = level > .001
        this.water.scale.y = Math.max(.001, height)
        this.water.position.set(this.center.x, chamber.min.y + height / 2, this.center.z)
        this.surface.position.set(this.center.x, waterY, this.center.z)
        this.surface.material.opacity = .4 + .05 * Math.sin(time * 2)
        this.sprayLines.visible = this.sprayParticles.visible = !!state.spray
        if (state.spray) updateParticles(this.sprayParticles, i => {
            const jet = jets[i % jets.length], t = fraction(time * 1.6 + i * .071)
            const p = jet.start.clone().lerp(jet.end, t)
            p.y -= .04 * t * t
            p.x += Math.sin(i * 17) * .018 * t
            return p
        })
        this.bubbles.visible = !!state.ultrasonic && level > .05
        if (this.bubbles.visible) updateParticles(this.bubbles, i => new THREE.Vector3(
            chamber.min.x + this.size.x * (.05 + .9 * fraction(i * .618)),
            chamber.min.y + height * (.04 + .92 * fraction(time * .23 + i * .113)),
            chamber.min.z + this.size.z * (.05 + .9 * fraction(i * .381))))
        this.rings.forEach((ring, i) => {
            ring.visible = level > .02 && (state.ultrasonic || state.fill)
            const phase = fraction(time * (state.ultrasonic ? .65 : .3) + i / this.rings.length)
            ring.position.set(this.center.x, waterY + .004 + i * .0005, this.center.z)
            ring.scale.set(this.size.x * .47 * phase, this.size.z * .47 * phase, 1)
            ring.material.opacity = .55 * (1 - phase)
        })
        this.airLines.forEach(line => { line.visible = !!state.blow })
        this.air.visible = !!state.blow
        if (state.blow) updateParticles(this.air, i => this.airPaths[i % this.airPaths.length].getPoint(fraction(time * .85 + i * .083)))
        this.droplets.visible = (state.drain || state.blow) && state.wetness > .02
        if (this.droplets.visible) updateParticles(this.droplets, i => {
            const t = fraction(time * .9 + i * .127)
            return point([this.center.x + Math.sin(i * 31) * .27, chamber.min.y + .52 - t * .5,
                this.center.z + Math.cos(i * 13) * .22])
        })
        for (const [flow, active] of [[this.fillFlow, state.fill], [this.drainFlow, state.drain]]) {
            flow.group.visible = !!active
            if (!active) continue
            updateParticles(flow.dots, i => flow.curve.getPoint(fraction(time * .5 + i / 16)))
            flow.arrows.forEach((arrow, i) => {
                const t = fraction(time * .35 + i / 3)
                arrow.position.copy(flow.curve.getPoint(t))
                arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), flow.curve.getTangent(t).normalize())
            })
        }
    }

    dispose() {
        for (const group of this.highlightGroups) for (const entry of group.entries) {
            entry.mesh.material = entry.original
            entry.cloned.forEach(material => material.dispose())
        }
        this.root.traverse(object => {
            object.geometry?.dispose()
            for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.dispose()
        })
        this.root.removeFromParent()
    }
}
