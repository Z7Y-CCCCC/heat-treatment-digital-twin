import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import gsap from 'gsap';
import { fitCameraBox } from '../utils/cameraBoxFit.js';
import { getBackendOrigin } from '../runtime/backendEndpoint.js';
import {
    composeSpatialTransforms,
    localToParentPoint,
    normalizeSpatialTransform,
    normalizeWorkshopLayout
} from '../utils/spatialLayout.js';

function createConcreteTexture() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#919793';
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 3600; i++) {
        const value = 126 + Math.floor(Math.random() * 46);
        const alpha = 0.035 + Math.random() * 0.08;
        ctx.fillStyle = `rgba(${value}, ${value}, ${value}, ${alpha})`;
        const x = Math.random() * size;
        const y = Math.random() * size;
        const radius = Math.random() * 1.6 + 0.25;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.strokeStyle = 'rgba(78, 86, 82, 0.12)';
    ctx.lineWidth = 1;
    for (let pos = 0; pos <= size; pos += 128) {
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(size, pos);
        ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(18, 18);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
}

function makeFloorPlane(width, depth, color, opacity) {
    const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1;
    return mesh;
}

function makeFloorArrow(length = 5.2, width = 2.1) {
    const shape = new THREE.Shape();
    const tail = length * 0.58;
    const half = width * 0.5;
    shape.moveTo(-length * 0.5, -half * 0.32);
    shape.lineTo(-length * 0.5 + tail, -half * 0.32);
    shape.lineTo(-length * 0.5 + tail, -half);
    shape.lineTo(length * 0.5, 0);
    shape.lineTo(-length * 0.5 + tail, half);
    shape.lineTo(-length * 0.5 + tail, half * 0.32);
    shape.lineTo(-length * 0.5, half * 0.32);
    shape.lineTo(-length * 0.5, -half * 0.32);
    const geometry = new THREE.ShapeGeometry(shape);
    const material = new THREE.MeshBasicMaterial({
        color: 0xdca441,
        transparent: true,
        opacity: 0.34,
        depthWrite: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 2;
    return mesh;
}

function disposeObject3D(object) {
    object.traverse((child) => {
        if (child.element?.parentNode) child.element.parentNode.removeChild(child.element);
        if (child.geometry) child.geometry.dispose();
        if (Array.isArray(child.material)) {
            child.material.forEach((mat) => mat.dispose());
        } else if (child.material) {
            child.material.dispose();
        }
    });
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function numberOrDefault(value, fallback = 0) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

// 后台编排坐标与 Unity 共用同一套世界坐标，预览层不再额外拉伸 Z 轴。
const LINE_LAYOUT_Z_VISUAL_SCALE = 1;

function layoutOffsetToSceneZ(offsetZ) {
    return numberOrDefault(offsetZ, 0) * LINE_LAYOUT_Z_VISUAL_SCALE;
}

function normalizeLineLayoutItems(items, type) {
    const isRail = type === 'rail';
    return (Array.isArray(items) ? items : [])
        .map((item, index) => ({
            id: String(item?.id || `${isRail ? 'rail' : 'lane'}_${index + 1}`),
            name: String(item?.name || `${isRail ? '小车导轨' : '设备线'} ${index + 1}`),
            type: isRail ? 'cart_rail' : 'device_lane',
            offsetZ: numberOrDefault(item?.offsetZ ?? item?.offset_z ?? item?.z, isRail ? 4 : 0),
            length: Math.max(1, numberOrDefault(item?.length, 60)),
            sort_order: numberOrDefault(item?.sort_order, index)
        }))
        .sort((a, b) => a.sort_order - b.sort_order);
}

function getLineLayout(line) {
    const source = parseJson(line?.layout || line?.layout_json, {});
    const lanes = normalizeLineLayoutItems(source.lanes, 'lane');
    const rails = normalizeLineLayoutItems(source.rails, 'rail');
    const flowDirection = ['right', 'left', 'none'].includes(source.flowDirection) ? source.flowDirection : 'right';
    if (!lanes.length) {
        lanes.push({ id: 'lane_1', name: '设备线 1', type: 'device_lane', offsetZ: 0, length: 60, sort_order: 0 });
    }
    return {
        version: Number(source.version || 1),
        coordinateSpace: source.coordinateSpace || (Number(source.version || 0) >= 2 ? 'workshop_local' : 'legacy_world'),
        transform: normalizeSpatialTransform(source.transform),
        flowDirection,
        lanes,
        rails
    };
}

function getLineBaseZ(globalLineIndex, line = null) {
    if (Number(getLineLayout(line).version || 0) >= 2) return 0;
    return -numberOrDefault(globalLineIndex, 0) * 16;
}

function getLineGuideWorldTransform(workshop, line, layout = getLineLayout(line)) {
    if (Number(layout.version || 0) < 2) return normalizeSpatialTransform(null);
    const workshopLayout = normalizeWorkshopLayout(workshop?.layout || workshop?.layout_json);
    return composeSpatialTransforms(workshopLayout.transform, layout.transform);
}

export class SceneManager {
    constructor(containerElement, onLevelChange, onDeviceSelect, interactionOptions = {}, renderOptions = {}) {
        this.container = containerElement;
        const bounds = this.container?.getBoundingClientRect?.();
        this.width = Math.max(1, Math.round(bounds?.width || window.innerWidth));
        this.height = Math.max(1, Math.round(bounds?.height || window.innerHeight));

        this.onLevelChange = onLevelChange; // Callback 通知 Vue 层级变化
        this.onDeviceSelect = onDeviceSelect; // Callback 传递选中的设备数据
        this.interactionOptions = interactionOptions || {};
        this.renderOptions = renderOptions || {};

        this.currentLevel = 0; // 0: 全局, 1: 产线, 2: 单机
        this.furnaces = [];
        this.batchRenderers = [];
        this.lineConfig = []; // 产线配置（由 setLineConfig 注入）
        this.lineDeviceRanges = []; // 每条产线在 furnaces 数组中的起止索引
        this.disposed = false;
        this.animationFrameId = null;
        this.boundOnWindowResize = this.onWindowResize.bind(this);
        this.boundAnimate = this.animate.bind(this);
        this.boundOnCanvasPointerDown = this.handleCanvasPointerDown.bind(this);
        this.boundOnCanvasPointerMove = this.handleCanvasPointerMove.bind(this);
        this.boundOnCanvasPointerUp = this.handleCanvasPointerUp.bind(this);
        this.labelsVisible = false;
        this.factoryGuideLayer = null;
        this.frameCount = 0;
        this.lastFrameTime = performance.now();
        this.lastRenderTime = 0;
        this.lastStatsTime = performance.now();
        this.lastStatsFrame = 0;
        this.targetFps = Math.max(15, Math.min(144, Number(this.renderOptions.targetFps) || 45));
        this.targetFrameMs = 1000 / this.targetFps;
        this.renderScale = Math.max(0.5, Math.min(1.5, Number(this.renderOptions.renderScale) || 1));
        this.antialiasEnabled = this.renderOptions.antialias === true;
        this.labelTargetFps = Math.max(1, Math.min(30, Number(this.renderOptions.labelFps) || 12));
        this.lastLabelRenderTime = 0;
        this.forceLabelRefreshUntil = 0;
        this.connectionBadgesSuppressedUntil = 0;
        this.connectionBadgeRestoreTimer = null;
        this.lastCameraSignature = '';
        this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.dragPoint = new THREE.Vector3();
        this.dragOffset = new THREE.Vector3();
        this.deviceDragState = null;
        this.suppressNextClick = false;
        this.webglContextLost = false;
        this.environmentObjects = [];
        this.concreteTexture = null;

        this.initScene();
        this.initCamera();
        this.initRenderer();
        this.initCSS2DRenderer();
        this.initControls();
        this.initLights();
        this.initEnvironment();
        this.initRaycaster();

        this.updatables = [];

        window.addEventListener('resize', this.boundOnWindowResize);
    }

    initScene() {
        this.scene = new THREE.Scene();

        if (this.renderOptions.lightweight === true) {
            const envColor = 0xaab3af;
            this.scene.background = new THREE.Color(envColor);
            const ground = new THREE.Mesh(
                new THREE.PlaneGeometry(560, 560),
                new THREE.MeshBasicMaterial({ color: 0x8a928e })
            );
            ground.rotation.x = -Math.PI / 2;
            ground.position.y = -0.1;
            this.scene.add(ground);
            this.environmentObjects.push(ground);

            const grid = new THREE.GridHelper(440, 32, 0x66716c, 0x77817d);
            grid.position.y = -0.085;
            grid.material.opacity = 0.1;
            grid.material.transparent = true;
            this.scene.add(grid);
            this.environmentObjects.push(grid);
            return;
        }
        
        // 真实车间观感：浅灰厂房、混凝土地坪、通道标线和尺度网格。
        const envColor = 0xa9b0ad;
        this.scene.background = new THREE.Color(envColor);
        this.scene.fog = new THREE.FogExp2(envColor, 0.0025);

        const groundGeo = new THREE.PlaneGeometry(560, 560);
        this.concreteTexture = createConcreteTexture();
        const groundMat = new THREE.MeshStandardMaterial({
            color: 0x858b88,
            map: this.concreteTexture,
            roughness: 0.86,
            metalness: 0.02,
            depthWrite: true
        });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.1;
        ground.receiveShadow = true;
        this.scene.add(ground);
        this.environmentObjects.push(ground);

        const grid = new THREE.GridHelper(440, 44, 0x6f7774, 0x777f7c);
        grid.position.y = -0.085;
        grid.material.opacity = 0.08;
        grid.material.transparent = true;
        this.scene.add(grid);
        this.environmentObjects.push(grid);

        const wallMat = new THREE.MeshStandardMaterial({ color: 0xb9bfbb, roughness: 0.9, metalness: 0.01 });
        const backWall = new THREE.Mesh(new THREE.PlaneGeometry(560, 72), wallMat);
        backWall.position.set(0, 35, -178);
        this.scene.add(backWall);
        this.environmentObjects.push(backWall);

        const baseWall = new THREE.Mesh(new THREE.BoxGeometry(560, 0.28, 2.2), new THREE.MeshStandardMaterial({ color: 0x747c79, roughness: 0.72 }));
        baseWall.position.set(0, 0.2, -176.9);
        this.scene.add(baseWall);
        this.environmentObjects.push(baseWall);

    }

    initCamera() {
        this.camera = new THREE.PerspectiveCamera(42, this.width / this.height, 0.1, 1000);
        // Level 0 初始相机位置：斜向俯视，更接近车间展示视角。
        this.camera.position.set(18, 26, 42);
        this.camera.lookAt(0, 0, 0);
    }

    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: this.antialiasEnabled,
            powerPreference: 'high-performance',
            precision: 'mediump'
        });
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(this.renderScale);
        this.renderer.domElement.style.touchAction = 'none';
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.05;
        
        // 多设备大屏优先保证帧率，默认关闭实时阴影，后续可做质量档位。
        this.renderer.shadowMap.enabled = false;

        this.boundOnWebglContextLost = (event) => {
            event.preventDefault();
            this.webglContextLost = true;
        };
        this.boundOnWebglContextRestored = () => {
            this.webglContextLost = false;
        };
        this.renderer.domElement.addEventListener('webglcontextlost', this.boundOnWebglContextLost, false);
        this.renderer.domElement.addEventListener('webglcontextrestored', this.boundOnWebglContextRestored, false);
        this.container.appendChild(this.renderer.domElement);
    }

    initCSS2DRenderer() {
        this.labelRenderer = new CSS2DRenderer();
        this.labelRenderer.domElement.classList.add('scene-label-layer');
        this.labelRenderer.setSize(this.width, this.height);
        this.labelRenderer.domElement.style.position = 'absolute';
        this.labelRenderer.domElement.style.top = '0px';
        this.labelRenderer.domElement.style.pointerEvents = 'none';
        this.labelRenderer.domElement.hidden = this.renderOptions.labelLayer === false;
        this.container.appendChild(this.labelRenderer.domElement);
    }

    initControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.065;
        this.controls.rotateSpeed = 0.72;
        this.controls.zoomSpeed = 0.9;
        this.controls.panSpeed = 0.62;
        this.controls.enablePan = true;
        this.controls.maxPolarAngle = Math.PI / 2 - 0.1;
        this.boundOnControlsStart = () => this.suppressConnectionBadges(600);
        this.boundOnControlsChange = () => this.suppressConnectionBadges(260);
        this.controls.addEventListener('start', this.boundOnControlsStart);
        this.controls.addEventListener('change', this.boundOnControlsChange);
    }

    initLights() {
        if (this.renderOptions.lightweight === true) {
            this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7772, 1.65));
            const light = new THREE.DirectionalLight(0xffffff, 1.15);
            light.position.set(24, 42, 18);
            this.scene.add(light);
            return;
        }
        // 使用半球光提供基础的体积感和漫反射（顶光白，地面暖灰）
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x6f7772, 1.45);
        this.scene.add(hemiLight);

        // 主光源，模拟厂房顶灯和侧向采光。
        const dirLight = new THREE.DirectionalLight(0xffffff, 2.2);
        dirLight.position.set(26, 48, 28);
        dirLight.castShadow = false;
        this.scene.add(dirLight);

        const fillLight = new THREE.DirectionalLight(0xf4eee2, 0.75);
        fillLight.position.set(-34, 28, -22);
        fillLight.castShadow = false;
        this.scene.add(fillLight);
    }

    initEnvironment() {
        if (this.renderOptions.environment === false || this.renderOptions.lightweight === true) return;
        const generator = new THREE.PMREMGenerator(this.renderer);
        generator.compileEquirectangularShader();
        const url = `${getBackendOrigin()}/assets/textures/industrial/blocky_photo_studio_1k.hdr`;
        new HDRLoader().load(url, (texture) => {
            if (this.disposed) {
                texture.dispose();
                generator.dispose();
                return;
            }
            const renderTarget = generator.fromEquirectangular(texture);
            texture.dispose();
            generator.dispose();
            if (this.disposed) {
                renderTarget.dispose();
                return;
            }
            this.environmentRenderTarget?.dispose?.();
            this.environmentRenderTarget = renderTarget;
            this.scene.environment = renderTarget.texture;
            if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = 0.82;
        }, undefined, (error) => {
            generator.dispose();
            console.warn('[SceneManager] HDR 环境光加载失败，继续使用基础灯光:', error);
        });
    }

    initRaycaster() {
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.boundOnCanvasClick = this.handleCanvasClick.bind(this);
        this.renderer.domElement.addEventListener('click', this.boundOnCanvasClick);
        if (this.interactionOptions.enableDeviceDrag) {
            this.renderer.domElement.addEventListener('pointerdown', this.boundOnCanvasPointerDown);
        }
    }

    setMouseFromPointerEvent(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    findDeviceFromPointerEvent(e) {
        this.setMouseFromPointerEvent(e);
        this.raycaster.setFromCamera(this.mouse, this.camera);

        const visibleFurnaces = this.furnaces.filter(furnace => furnace.visible);
        const intersects = this.raycaster.intersectObjects(visibleFurnaces, true);
        if (!intersects.length) return null;

        let object = intersects[0].object;
        while (object.parent && !object.userData.isDevice) { object = object.parent; }
        if (!object.userData.isDevice) return null;
        return object;
    }

    getGroundPointFromPointerEvent(e) {
        this.setMouseFromPointerEvent(e);
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const point = this.raycaster.ray.intersectPlane(this.dragPlane, this.dragPoint);
        return point ? this.dragPoint : null;
    }

    isDeviceDraggable(device) {
        const canDragDevice = this.interactionOptions.canDragDevice;
        if (typeof canDragDevice !== 'function') return true;
        return !!canDragDevice(device.userData.id, device);
    }

    handleCanvasPointerDown(e) {
        if (e.button !== 0 || !this.interactionOptions.enableDeviceDrag) return;

        const device = this.findDeviceFromPointerEvent(e);
        if (!device || !this.isDeviceDraggable(device)) return;

        const groundPoint = this.getGroundPointFromPointerEvent(e);
        if (!groundPoint) return;

        this.deviceDragState = {
            device,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            startYPosition: device.position.y
        };
        this.dragOffset.copy(device.position).sub(groundPoint);
        this.dragOffset.y = 0;

        if (this.controls) this.controls.enabled = false;
        this.renderer.domElement.style.cursor = 'grabbing';
        this.renderer.domElement.setPointerCapture?.(e.pointerId);
        window.addEventListener('pointermove', this.boundOnCanvasPointerMove);
        window.addEventListener('pointerup', this.boundOnCanvasPointerUp);
        window.addEventListener('pointercancel', this.boundOnCanvasPointerUp);
        this.interactionOptions.onDeviceDragStart?.(device.userData.id, device);
        e.preventDefault();
        e.stopPropagation();
    }

    handleCanvasPointerMove(e) {
        if (!this.deviceDragState) return;

        const groundPoint = this.getGroundPointFromPointerEvent(e);
        if (!groundPoint) return;

        const { device, startX, startY, startYPosition } = this.deviceDragState;
        if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) {
            this.deviceDragState.moved = true;
        }
        if (!this.deviceDragState.moved) return;

        const nextX = groundPoint.x + this.dragOffset.x;
        const nextZ = groundPoint.z + this.dragOffset.z;
        device.position.set(nextX, startYPosition, nextZ);
        this.forceLabelRefreshUntil = performance.now() + 250;
        this.interactionOptions.onDeviceDrag?.(device.userData.id, {
            x: nextX,
            y: startYPosition,
            z: nextZ
        }, device);
        e.preventDefault();
    }

    handleCanvasPointerUp(e) {
        if (!this.deviceDragState) return;

        const { device, pointerId, moved } = this.deviceDragState;
        this.deviceDragState = null;
        if (this.controls) this.controls.enabled = true;
        this.renderer.domElement.style.cursor = '';
        this.renderer.domElement.releasePointerCapture?.(pointerId);
        window.removeEventListener('pointermove', this.boundOnCanvasPointerMove);
        window.removeEventListener('pointerup', this.boundOnCanvasPointerUp);
        window.removeEventListener('pointercancel', this.boundOnCanvasPointerUp);

        if (moved) this.suppressNextClick = true;
        this.interactionOptions.onDeviceDragEnd?.(device.userData.id, {
            x: device.position.x,
            y: device.position.y,
            z: device.position.z
        }, device, { moved });
        e.preventDefault();
    }

    handleCanvasClick(e) {
        if (this.suppressNextClick) {
            this.suppressNextClick = false;
            return;
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        
        // 找出所有可以被点击的炉子
        const visibleFurnaces = this.furnaces.filter(furnace => furnace.visible);
        const intersects = this.raycaster.intersectObjects(visibleFurnaces, true);

        if (intersects.length > 0) {
            // 点击到了模型
            let object = intersects[0].object;
            while (object.parent && !object.userData.isDevice) { object = object.parent; }
            if (!object.userData.isDevice) return;

            const idx = this.furnaces.indexOf(object);
            const info = this.getDeviceLineInfo(idx);
            if (!info) return;

            if (!info.isLineMember) {
                this.flyToDevice(object);
                return;
            }

            if (this.currentLevel === 0) {
                // 全局视角点击，进入对应车间
                this.flyToWorkshop(info.workshopIdx);
                window.dispatchEvent(new CustomEvent('workshop-selected', { detail: info.workshopIdx }));
            } else if (this.currentLevel === 1) {
                // 车间视角点击，进入对应产线
                this.flyToLine(info.globalLineIndex);
                window.dispatchEvent(new CustomEvent('line-selected', { detail: info.globalLineIndex }));
            } else if (this.currentLevel === 2) {
                // 产线视角点击，进入设备详情
                this.flyToDevice(object);
            }
        }
    }

    addFurnace(furnace) {
        this.scene.add(furnace);
        this.updatables.push(furnace);
        this.furnaces.push(furnace);
    }

    addBatchRenderer(batchRenderer) {
        this.scene.add(batchRenderer);
        this.updatables.push(batchRenderer);
        this.batchRenderers.push(batchRenderer);
    }

    /**
     * 接收车间、产线、设备的拓扑结构
     */
    setTopologyConfig(workshops, cameraMode) {
        this.workshops = workshops;
        this.cameraMode = cameraMode || 'auto';
        
        this.lineDeviceRanges = [];
        workshops.forEach((ws, wsIdx) => {
            (ws.lines || []).forEach((line) => {
                const globalLineIndex = this.lineDeviceRanges.length;
                const layout = getLineLayout(line);
                this.lineDeviceRanges.push({
                    lineId: line.id,
                    line,
                    layout,
                    baseZ: getLineBaseZ(globalLineIndex, line),
                    worldTransform: getLineGuideWorldTransform(ws, line, layout),
                    workshopIdx: wsIdx,
                    globalLineIndex
                });
            });
        });
        
        if (this.cameraMode === '4level' || (this.cameraMode === 'auto' && workshops.length > 1)) {
            this.topLevel = 0; // Factory
        } else {
            this.topLevel = 1; // Workshop
        }

        this.buildFactoryGuides();
        this.updateFactoryGuideVisibility();
    }

    clearFactoryGuides() {
        if (!this.factoryGuideLayer) return;
        this.scene.remove(this.factoryGuideLayer);
        disposeObject3D(this.factoryGuideLayer);
        this.factoryGuideLayer = null;
    }

    buildFactoryGuides() {
        this.clearFactoryGuides();
        const layer = new THREE.Group();
        layer.name = 'factory_layout_guides';

        this.lineDeviceRanges.forEach((range) => {
            const bounds = this.getLineLocalGuideBounds(range, 7, 5);
            const width = Math.max(64, bounds.spanX);
            const depth = Math.max(10, bounds.spanZ);
            const centerX = bounds.centerX;
            const centerZ = bounds.centerZ;
            const group = new THREE.Group();
            group.name = `factory_line_guide_${range.globalLineIndex}`;
            group.userData = {
                globalLineIndex: range.globalLineIndex,
                workshopIdx: range.workshopIdx
            };
            const worldTransform = range.worldTransform || normalizeSpatialTransform(null);
            group.position.set(worldTransform.x, worldTransform.y, worldTransform.z);
            group.rotation.y = -THREE.MathUtils.degToRad(worldTransform.rotationY);

            const zone = makeFloorPlane(width, depth, range.globalLineIndex % 2 === 0 ? 0x4a6f62 : 0x596a70, 0.13);
            zone.position.set(centerX, -0.052, centerZ);
            group.add(zone);

            this.addLineLayoutMarks(group, range);
            this.addLineBadge(group, range, centerX - width * 0.18, centerZ - depth * 0.5 - 1.8);
            layer.add(group);
        });

        this.factoryGuideLayer = layer;
        this.scene.add(layer);
    }

    addFloorBorder(group, centerX, centerZ, width, depth) {
        const borderMat = new THREE.MeshBasicMaterial({
            color: 0xe0ad4f,
            transparent: true,
            opacity: 0.72,
            depthWrite: false
        });
        const thickness = 0.16;
        const parts = [
            { size: [width, thickness], pos: [centerX, centerZ - depth / 2] },
            { size: [width, thickness], pos: [centerX, centerZ + depth / 2] },
            { size: [thickness, depth], pos: [centerX - width / 2, centerZ] },
            { size: [thickness, depth], pos: [centerX + width / 2, centerZ] }
        ];
        parts.forEach(({ size, pos }) => {
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), borderMat.clone());
            mesh.rotation.x = -Math.PI / 2;
            mesh.position.set(pos[0], -0.045, pos[1]);
            mesh.renderOrder = 3;
            group.add(mesh);
        });
    }

    addFlowArrows(group, centerX, centerZ, width, direction = 'right', options = {}) {
        if (direction === 'none') return;
        const count = Math.max(1, options.count ?? Math.max(2, Math.min(5, Math.floor(width / 16))));
        const useEndMarker = options.anchor === 'end';
        const startX = useEndMarker
            ? centerX + (direction === 'left' ? -width * 0.42 : width * 0.42)
            : centerX - width * 0.34;
        const step = useEndMarker ? 0 : width * 0.68 / Math.max(1, count - 1);
        for (let i = 0; i < count; i++) {
            const arrow = makeFloorArrow(options.length || 5.2, options.width || 2.1);
            if (direction === 'left') {
                arrow.rotation.z = Math.PI;
            }
            if (options.color) arrow.material.color.setHex(options.color);
            if (Number.isFinite(options.opacity)) arrow.material.opacity = options.opacity;
            arrow.renderOrder = options.renderOrder || 8;
            arrow.position.set(startX + i * step, options.y ?? -0.03, centerZ);
            group.add(arrow);
        }
    }

    addLineBadge(group, range, x, z) {
        const workshop = this.workshops?.[range.workshopIdx];
        const line = workshop?.lines?.find(item => item.id === range.lineId);
        const div = document.createElement('div');
        div.className = 'factory-guide-label';
        const workshopLabel = document.createElement('span');
        workshopLabel.textContent = workshop?.name || '车间';
        const lineLabel = document.createElement('strong');
        lineLabel.textContent = line?.name || `产线 ${range.globalLineIndex + 1}`;
        div.append(workshopLabel, lineLabel);
        const label = new CSS2DObject(div);
        label.userData.isFactoryGuideLabel = true;
        label.position.set(x, 0.25, z);
        group.add(label);
    }

    getPrimaryLaneZ(range, fallbackZ) {
        const lane = range?.layout?.lanes?.[0];
        if (!lane) return fallbackZ;
        return numberOrDefault(range.baseZ, 0) + layoutOffsetToSceneZ(lane.offsetZ);
    }

    addLineLayoutMarks(group, range) {
        const layout = range.layout || getLineLayout(range.line);
        const baseZ = numberOrDefault(range.baseZ, getLineBaseZ(range.globalLineIndex));
        const laneMat = new THREE.MeshBasicMaterial({
            color: 0x8ab6ca,
            transparent: true,
            opacity: 0.34,
            depthWrite: false
        });
        const laneCenterMat = new THREE.MeshBasicMaterial({
            color: 0x5b91a8,
            transparent: true,
            opacity: 0.72,
            depthWrite: false
        });
        const railMat = new THREE.MeshBasicMaterial({
            color: 0xc38a2e,
            transparent: true,
            opacity: 0.84,
            depthWrite: false
        });
        const sleeperMat = new THREE.MeshBasicMaterial({
            color: 0x6f5a34,
            transparent: true,
            opacity: 0.44,
            depthWrite: false
        });

        const flowDirection = layout.flowDirection || 'right';

        layout.lanes.forEach((lane) => {
            const length = Math.max(4, numberOrDefault(lane.length, 60));
            const z = baseZ + layoutOffsetToSceneZ(lane.offsetZ);
            const strip = new THREE.Mesh(new THREE.PlaneGeometry(length, 2.2), laneMat.clone());
            strip.rotation.x = -Math.PI / 2;
            strip.position.set(0, -0.039, z);
            strip.renderOrder = 4;
            group.add(strip);

            const center = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.14), laneCenterMat.clone());
            center.rotation.x = -Math.PI / 2;
            center.position.set(0, -0.035, z);
            center.renderOrder = 5;
            group.add(center);

            this.addFlowArrows(group, 0, z, length, flowDirection, {
                count: 1,
                anchor: 'end',
                length: 3.9,
                width: 1.45,
                color: 0xd7a043,
                opacity: 0.56,
                y: -0.028,
                renderOrder: 8
            });
        });

        layout.rails.forEach((rail) => {
            const length = Math.max(4, numberOrDefault(rail.length, 60));
            const z = baseZ + layoutOffsetToSceneZ(rail.offsetZ);
            [-0.42, 0.42].forEach((offset) => {
                const railMesh = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.16), railMat.clone());
                railMesh.rotation.x = -Math.PI / 2;
                railMesh.position.set(0, -0.032, z + offset);
                railMesh.renderOrder = 6;
                group.add(railMesh);
            });

            const sleeperCount = Math.max(6, Math.min(18, Math.floor(length / 4)));
            const step = length / Math.max(1, sleeperCount - 1);
            for (let i = 0; i < sleeperCount; i++) {
                const x = -length / 2 + i * step;
                const sleeper = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1.2), sleeperMat.clone());
                sleeper.rotation.x = -Math.PI / 2;
                sleeper.position.set(x, -0.034, z);
                sleeper.renderOrder = 5;
                group.add(sleeper);
            }
        });
    }

    updateFactoryGuideVisibility() {
        if (!this.factoryGuideLayer) return;
        this.factoryGuideLayer.visible = this.currentLevel < 3;
        this.factoryGuideLayer.children.forEach((lineGroup) => {
            if (this.currentLevel === 0) {
                lineGroup.visible = true;
            } else if (this.currentLevel === 1) {
                lineGroup.visible = lineGroup.userData.workshopIdx === this.activeWorkshopIdx;
            } else if (this.currentLevel === 2) {
                lineGroup.visible = lineGroup.userData.globalLineIndex === this.activeLineIndex;
            } else {
                lineGroup.visible = false;
            }
            lineGroup.traverse((child) => {
                if (child.userData?.isFactoryGuideLabel) {
                    child.visible = lineGroup.visible && this.currentLevel < 2;
                }
            });
        });
    }

    /**
     * 获取某条产线的设备列表（内部产线全局索引）
     */
    getLineDevices(globalLineIndex) {
        return this.furnaces.filter(device => {
            return device.userData?.globalLineIndex === globalLineIndex
                && device.userData?.isLineMember !== false;
        });
    }

    getLineAuxiliaryDevices(globalLineIndex) {
        const range = this.lineDeviceRanges[globalLineIndex];
        return this.furnaces.filter(device => {
            if (device.userData?.isLineMember !== false) return false;
            if (device.userData?.globalLineIndex === globalLineIndex) return true;
            return range?.lineId && device.userData?.lineId === range.lineId;
        });
    }

    getLineStructureDevices(globalLineIndex) {
        return [
            ...this.getLineDevices(globalLineIndex),
            ...this.getLineAuxiliaryDevices(globalLineIndex)
        ];
    }

    getLineSceneBounds(range, devicesList = [], paddingX = 0, paddingZ = 0) {
        const xs = [];
        const zs = [];
        devicesList.forEach((device) => {
            xs.push(device.position.x);
            zs.push(device.position.z);
        });

        const layout = range?.layout || getLineLayout(range?.line);
        const baseZ = numberOrDefault(range?.baseZ, getLineBaseZ(range?.globalLineIndex, range?.line));
        const worldTransform = range?.worldTransform || normalizeSpatialTransform(null);
        [...(layout.lanes || []), ...(layout.rails || [])].forEach((item) => {
            const halfLength = Math.max(1, numberOrDefault(item.length, 60) / 2);
            const localZ = baseZ + layoutOffsetToSceneZ(item.offsetZ);
            const start = localToParentPoint({ x: -halfLength, z: localZ }, worldTransform);
            const end = localToParentPoint({ x: halfLength, z: localZ }, worldTransform);
            xs.push(start.x, end.x);
            zs.push(start.z, end.z);
        });

        if (!xs.length) xs.push(-30, 30);
        if (!zs.length) zs.push(baseZ);

        const minX = Math.min(...xs) - paddingX;
        const maxX = Math.max(...xs) + paddingX;
        const minZ = Math.min(...zs) - paddingZ;
        const maxZ = Math.max(...zs) + paddingZ;

        return {
            minX,
            maxX,
            minZ,
            maxZ,
            centerX: (minX + maxX) / 2,
            centerZ: (minZ + maxZ) / 2,
            spanX: Math.max(12, maxX - minX),
            spanZ: Math.max(12, maxZ - minZ)
        };
    }

    getLineLocalGuideBounds(range, paddingX = 0, paddingZ = 0) {
        const layout = range?.layout || getLineLayout(range?.line);
        const baseZ = numberOrDefault(range?.baseZ, getLineBaseZ(range?.globalLineIndex, range?.line));
        const xs = [];
        const zs = [];
        [...(layout.lanes || []), ...(layout.rails || [])].forEach((item) => {
            const halfLength = Math.max(1, numberOrDefault(item.length, 60) / 2);
            xs.push(-halfLength, halfLength);
            zs.push(baseZ + layoutOffsetToSceneZ(item.offsetZ));
        });
        if (!xs.length) xs.push(-30, 30);
        if (!zs.length) zs.push(baseZ);
        const minX = Math.min(...xs) - paddingX;
        const maxX = Math.max(...xs) + paddingX;
        const minZ = Math.min(...zs) - paddingZ;
        const maxZ = Math.max(...zs) + paddingZ;
        return {
            minX,
            maxX,
            minZ,
            maxZ,
            centerX: (minX + maxX) / 2,
            centerZ: (minZ + maxZ) / 2,
            spanX: Math.max(12, maxX - minX),
            spanZ: Math.max(12, maxZ - minZ)
        };
    }
    
    /**
     * 获取某个车间的设备列表
     */
    getWorkshopDevices(workshopIdx) {
        return this.furnaces.filter(device => device.userData?.workshopIdx === workshopIdx);
    }

    /**
     * 根据炉子索引判断其归属
     */
    getDeviceLineInfo(furnaceIdx) {
        const device = this.furnaces[furnaceIdx];
        if (!device?.userData || !Number.isFinite(Number(device.userData.workshopIdx))) return null;
        return {
            globalLineIndex: Number(device.userData.globalLineIndex),
            workshopIdx: Number(device.userData.workshopIdx),
            isLineMember: device.userData.isLineMember !== false
        };
    }

    getDevicesBounds(devicesList, paddingX = 0, paddingZ = 0) {
        let minZ = 0, maxZ = 0, minX = 0, maxX = 0;
        let minY = 0, maxY = 0;
        if (devicesList.length > 0) {
            minZ = devicesList[0].position.z; maxZ = minZ;
            minX = devicesList[0].position.x; maxX = minX;
            devicesList.forEach(f => {
                minZ = Math.min(minZ, f.position.z);
                maxZ = Math.max(maxZ, f.position.z);
                minX = Math.min(minX, f.position.x);
                maxX = Math.max(maxX, f.position.x);
                f.updateMatrixWorld?.(true);
                const box = new THREE.Box3().setFromObject(f);
                if (!box.isEmpty()) {
                    minX = Math.min(minX, box.min.x); maxX = Math.max(maxX, box.max.x);
                    minZ = Math.min(minZ, box.min.z); maxZ = Math.max(maxZ, box.max.z);
                    minY = Math.min(minY, box.min.y); maxY = Math.max(maxY, box.max.y);
                }
            });
        }

        minX -= paddingX;
        maxX += paddingX;
        minZ -= paddingZ;
        maxZ += paddingZ;

        return {
            minX,
            maxX,
            minZ,
            maxZ,
            minY,
            maxY,
            centerX: (minX + maxX) / 2,
            centerZ: (minZ + maxZ) / 2,
            spanX: Math.max(12, maxX - minX),
            spanZ: Math.max(12, maxZ - minZ)
        };
    }

    getCameraFitSpan(bounds) {
        const aspect = Math.max(1, this.width / Math.max(1, this.height));
        return Math.max(bounds.spanZ, (bounds.spanX / aspect) * 1.45);
    }

    // --- 运镜控制 ---

    flyToFactory() {
        if (this.topLevel > 0) {
            this.flyToWorkshop(0); // 跳过工厂视角，直接进第一个车间
            return;
        }
        this.requestLabelRefresh(2200);
        this.currentLevel = 0;
        this.onLevelChange(0);
        this.updateFactoryGuideVisibility();
        this._flyToDevices(this.furnaces, 0, 0.8, 0.6);
        this.furnaces.forEach(f => {
            f.visible = true;
            f.setLabelVisible(false);
            f.setXRayMode(false);
        });
        this.labelsVisible = false;
    }

    flyToWorkshop(wsIdx) {
        this.requestLabelRefresh(1800);
        this.activeWorkshopIdx = wsIdx;
        this.currentLevel = 1;
        this.onLevelChange(1);
        this.updateFactoryGuideVisibility();
        const wsDevices = this.getWorkshopDevices(wsIdx);
        if (wsDevices.length === 0) return;
        this._flyToDevices(wsDevices, 0, 0.6, 0.5);
        this.furnaces.forEach((f, idx) => {
            const info = this.getDeviceLineInfo(idx);
            f.visible = (info && info.workshopIdx === wsIdx);
            f.setXRayMode(false);
            f.setLabelVisible(false);
        });
        this.labelsVisible = false;
    }

    flyToLine(globalLineIndex) {
        this.requestLabelRefresh(1800);
        this.activeLineIndex = globalLineIndex;
        this.currentLevel = 2;
        this.onLevelChange(2);
        this.updateFactoryGuideVisibility();
        
        const lineRange = this.lineDeviceRanges[globalLineIndex];
        if (!lineRange) return;
        const lineDevices = this.getLineStructureDevices(globalLineIndex);

        const bounds = this.getLineSceneBounds(lineRange, lineDevices, 7, 5);
        const fitSpan = this.getCameraFitSpan(bounds);
        const cameraHeight = Math.max(42, fitSpan * 1.22);
        const cameraZ = bounds.centerZ + Math.max(3, fitSpan * 0.06);
        
        // 产线层级采用近似俯视视角，保证后台 X/Z 平面编排和大屏布局方向一致。
        gsap.to(this.camera.position, { x: bounds.centerX, y: cameraHeight, z: cameraZ, duration: 1.5, ease: "power2.inOut" });
        gsap.to(this.controls.target, { x: bounds.centerX, y: 0.4, z: bounds.centerZ, duration: 1.5, ease: "power2.inOut" });
        
        // 隐藏其他产线，只显示当前产线，并显示悬浮标签
        this.furnaces.forEach((f, idx) => {
            const info = this.getDeviceLineInfo(idx);
            const isMatch = (info && info.isLineMember && info.globalLineIndex === globalLineIndex);
            const isWorkshopAuxiliary = info && !info.isLineMember && lineRange && info.workshopIdx === lineRange.workshopIdx && info.globalLineIndex === globalLineIndex;
            f.visible = isMatch || isWorkshopAuxiliary;
            f.setXRayMode(false);
            f.setLabelVisible(isMatch);
        });
        this.labelsVisible = true;
    }

    flyToDevice(device) {
        this.requestLabelRefresh(1800);
        this.activeDeviceId = device.userData.id;
        this.currentLevel = 3;
        this.onLevelChange(3);
        this.updateFactoryGuideVisibility();
        this.onDeviceSelect(device.userData.id);

        const targetX = device.position.x;
        const targetZ = device.position.z;

        // 极限特写镜头，拉近观察内部
        gsap.to(this.camera.position, { x: targetX + 5, y: 4, z: targetZ + 6, duration: 1.5, ease: "power2.inOut" });
        gsap.to(this.controls.target, { x: targetX, y: 1.5, z: targetZ, duration: 1.5, ease: "power2.inOut" });
        
        // 隐藏其他设备，选中的设备开启透明(X-Ray)模式并隐藏顶部悬浮标签
        this.furnaces.forEach(f => {
            if (f === device) {
                f.visible = true;
                f.setLabelVisible(false); 
                f.setXRayMode(true);
            } else {
                f.visible = false;
                f.setLabelVisible(false);
                f.setXRayMode(false);
            }
        });
        this.labelsVisible = true;
    }

    goUp() {
        if (this.currentLevel === 3) {
            // 从设备返回产线
            const activeFurnace = this.furnaces.find(f => f.userData.id === this.activeDeviceId);
            if (activeFurnace) {
                const idx = this.furnaces.indexOf(activeFurnace);
                const info = this.getDeviceLineInfo(idx);
                if(info?.isLineMember) {
                    this.flyToLine(info.globalLineIndex);
                    window.dispatchEvent(new CustomEvent('line-selected', { detail: info.globalLineIndex }));
                } else if (info) {
                    this.flyToWorkshop(info.workshopIdx);
                    window.dispatchEvent(new CustomEvent('workshop-selected', { detail: info.workshopIdx }));
                }
            }
        } else if (this.currentLevel === 2) {
            // 从产线返回车间
            const range = this.lineDeviceRanges[this.activeLineIndex];
            if(range) {
                this.flyToWorkshop(range.workshopIdx);
                window.dispatchEvent(new CustomEvent('workshop-selected', { detail: range.workshopIdx }));
            }
        } else if (this.currentLevel === 1) {
            // 从车间返回工厂（如果允许）
            if (this.topLevel === 0) {
                this.flyToFactory();
                window.dispatchEvent(new CustomEvent('factory-selected'));
            }
        }
    }

    _flyToDevices(devicesList, yOffset, heightRatio, zRatio) {
        const bounds = this.getDevicesBounds(devicesList, 10, 8);
        const fit = fitCameraBox(bounds, { fov: this.camera.fov, aspect: this.camera.aspect, direction: [.08, heightRatio, zRatio] });
        const [x, y, z] = fit.position, [tx, ty, tz] = fit.target;
        gsap.to(this.camera.position, { x, y: y + yOffset, z, duration: 2.0, ease: "power2.inOut" });
        gsap.to(this.controls.target, { x: tx, y: ty, z: tz, duration: 2.0, ease: "power2.inOut" });
    }

    requestLabelRefresh(durationMs = 800) {
        this.forceLabelRefreshUntil = Math.max(this.forceLabelRefreshUntil, performance.now() + durationMs);
        this.suppressConnectionBadges(durationMs + 160);
    }

    suppressConnectionBadges(durationMs = 800) {
        if (this.disposed) return;
        const until = performance.now() + Math.max(120, durationMs);
        this.connectionBadgesSuppressedUntil = Math.max(this.connectionBadgesSuppressedUntil, until);
        this.applyConnectionBadgeVisibility();

        if (this.connectionBadgeRestoreTimer) clearTimeout(this.connectionBadgeRestoreTimer);
        this.connectionBadgeRestoreTimer = setTimeout(() => {
            this.connectionBadgeRestoreTimer = null;
            this.applyConnectionBadgeVisibility();
        }, Math.max(120, durationMs) + 40);
    }

    isConnectionBadgeSuppressed() {
        return performance.now() < this.connectionBadgesSuppressedUntil;
    }

    getConnectionBadgeEntries() {
        const entries = [];
        this.furnaces.forEach(device => {
            const standardBadge = device?.userData?.connectionBadge;
            if (standardBadge?.label && standardBadge?.div) {
                entries.push({
                    label: standardBadge.label,
                    div: standardBadge.div,
                    quality: device.userData.quality || device.userData.connectionVisualQuality || 'bad'
                });
            }
            if (device?.connectionBadgeObj && device?.connectionBadgeDiv) {
                entries.push({
                    label: device.connectionBadgeObj,
                    div: device.connectionBadgeDiv,
                    quality: device.userData?.quality || 'bad'
                });
            }
        });
        return entries;
    }

    applyConnectionBadgeVisibility() {
        const suppressed = this.isConnectionBadgeSuppressed();
        let changed = false;
        this.getConnectionBadgeEntries().forEach(({ label, div, quality }) => {
            const shouldShow = !suppressed && (quality === 'bad' || quality === 'stale');
            if (label.visible !== shouldShow) changed = true;
            label.visible = shouldShow;
            div.style.opacity = shouldShow ? '1' : '0';
        });
        if (changed) this.renderLabelLayerOnce();
    }

    renderLabelLayerOnce() {
        if (this.renderOptions.labelLayer === false) return;
        if (!this.labelRenderer || !this.scene || !this.camera) return;
        this.labelRenderer.render(this.scene, this.camera);
    }

    getCameraSignature() {
        if (!this.camera || !this.controls) return '';
        const p = this.camera.position;
        const t = this.controls.target;
        return [
            p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3),
            t.x.toFixed(3), t.y.toFixed(3), t.z.toFixed(3)
        ].join('|');
    }

    suppressBadgesWhileCameraMoves() {
        const signature = this.getCameraSignature();
        if (!signature) return;
        if (!this.lastCameraSignature) {
            this.lastCameraSignature = signature;
            return;
        }
        if (signature !== this.lastCameraSignature) {
            this.lastCameraSignature = signature;
            this.suppressConnectionBadges(260);
        }
    }

    // --- 供 UI 调用的视角控制 API ---
    rotateCamera(angleDelta) {
        this.requestLabelRefresh(700);
        // 围绕 target 旋转
        const r = this.camera.position.distanceTo(this.controls.target);
        // 当前角度
        const theta = Math.atan2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z);
        const newTheta = theta + angleDelta;
        
        gsap.to(this.camera.position, {
            x: this.controls.target.x + r * Math.sin(newTheta),
            z: this.controls.target.z + r * Math.cos(newTheta),
            duration: 0.5,
            ease: "power1.out"
        });
    }

    zoomCamera(zoomIn) {
        this.requestLabelRefresh(700);
        const dir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
        const dist = zoomIn ? 3 : -3;
        gsap.to(this.camera.position, {
            x: this.camera.position.x + dir.x * dist,
            y: this.camera.position.y + dir.y * dist,
            z: this.camera.position.z + dir.z * dist,
            duration: 0.5,
            ease: "power1.out"
        });
    }

    onWindowResize() {
        const bounds = this.container?.getBoundingClientRect?.();
        this.width = Math.max(1, Math.round(bounds?.width || window.innerWidth));
        this.height = Math.max(1, Math.round(bounds?.height || window.innerHeight));
        this.camera.aspect = this.width / this.height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(this.renderScale);
        this.labelRenderer.setSize(this.width, this.height);
        this.requestLabelRefresh(300);
    }

    isRenderSurfaceHealthy() {
        const canvas = this.renderer?.domElement;
        const context = this.renderer?.getContext?.();
        return !this.disposed
            && !this.webglContextLost
            && !!canvas
            && canvas.isConnected
            && this.container?.contains?.(canvas)
            && canvas.width > 1
            && canvas.height > 1
            && !(context?.isContextLost?.() === true);
    }

    animate(now = performance.now()) {
        if (this.disposed) return;
        this.animationFrameId = requestAnimationFrame(this.boundAnimate);

        const elapsedSinceRender = this.lastRenderTime ? now - this.lastRenderTime : this.targetFrameMs;
        if (elapsedSinceRender < this.targetFrameMs) return;

        const delta = Math.min((now - this.lastFrameTime) / 1000, 0.1);
        this.lastRenderTime = this.lastRenderTime
            ? now - (elapsedSinceRender % this.targetFrameMs)
            : now;
        this.lastFrameTime = now;

        for (const obj of this.updatables) {
            if (obj.visible && obj.update) obj.update(delta);
        }

        this.controls.update();
        this.suppressBadgesWhileCameraMoves();
        // 恢复原生高性能渲染，不用 Composer
        this.renderer.render(this.scene, this.camera);
        this.frameCount += 1;
        if (this.frameCount % 15 === 0) {
            const statsElapsed = Math.max(1, now - this.lastStatsTime);
            const renderFps = (this.frameCount - this.lastStatsFrame) * 1000 / statsElapsed;
            window.__DASHBOARD_RENDERER_INFO__ = {
                calls: this.renderer.info.render.calls,
                triangles: this.renderer.info.render.triangles,
                lines: this.renderer.info.render.lines,
                points: this.renderer.info.render.points,
                pixelRatio: this.renderer.getPixelRatio(),
                renderFps: Number(renderFps.toFixed(1)),
                targetFps: this.targetFps,
                renderProfile: this.renderOptions.profile || 'balanced',
                antialias: this.antialiasEnabled,
                labelTargetFps: this.labelTargetFps,
                environmentReady: !!this.scene.environment,
                guideTransforms: this.lineDeviceRanges.map(range => ({
                    lineId: range.lineId,
                    ...range.worldTransform
                })),
                optimizedModels: this.batchRenderers.map(renderer => renderer.userData.optimization).filter(Boolean)
            };
            this.lastStatsTime = now;
            this.lastStatsFrame = this.frameCount;
        }
        const hasConnectionBadges = this.renderOptions.labelLayer !== false && this.hasVisibleConnectionBadges();
        if (this.renderOptions.labelLayer !== false && (this.labelsVisible || this.factoryGuideLayer?.visible || hasConnectionBadges)) {
            const requestedLabelFps = now < this.forceLabelRefreshUntil
                ? Math.min(this.targetFps, this.labelTargetFps * 2)
                : this.labelTargetFps;
            const labelFrameMs = 1000 / requestedLabelFps;
            const labelElapsed = this.lastLabelRenderTime ? now - this.lastLabelRenderTime : labelFrameMs;
            if (labelElapsed >= labelFrameMs) {
                this.labelRenderer.render(this.scene, this.camera);
                this.lastLabelRenderTime = this.lastLabelRenderTime
                    ? now - (labelElapsed % labelFrameMs)
                    : now;
            }
        }
    }

    hasVisibleConnectionBadges() {
        if (this.isConnectionBadgeSuppressed()) {
            this.applyConnectionBadgeVisibility();
            return false;
        }
        this.applyConnectionBadgeVisibility();
        return this.getConnectionBadgeEntries().some(entry => entry.label.visible);
    }

    /**
     * 销毁渲染器和所有资源，防止路由切换时 WebGL 上下文泄漏
     */
    dispose() {
        this.disposed = true;
        if (this.connectionBadgeRestoreTimer) {
            clearTimeout(this.connectionBadgeRestoreTimer);
            this.connectionBadgeRestoreTimer = null;
        }
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        window.removeEventListener('resize', this.boundOnWindowResize);
        if (this.renderer?.domElement && this.boundOnCanvasClick) {
            this.renderer.domElement.removeEventListener('click', this.boundOnCanvasClick);
        }
        if (this.renderer?.domElement && this.boundOnCanvasPointerDown) {
            this.renderer.domElement.removeEventListener('pointerdown', this.boundOnCanvasPointerDown);
            if (this.deviceDragState?.pointerId != null) {
                this.renderer.domElement.releasePointerCapture?.(this.deviceDragState.pointerId);
            }
        }
        window.removeEventListener('pointermove', this.boundOnCanvasPointerMove);
        window.removeEventListener('pointerup', this.boundOnCanvasPointerUp);
        window.removeEventListener('pointercancel', this.boundOnCanvasPointerUp);
        
        // 销毁所有炉子模型的几何体和材质
        this.furnaces.forEach(f => {
            if (f.dispose) f.dispose();
        });
        this.batchRenderers.forEach(batchRenderer => {
            if (batchRenderer.dispose) batchRenderer.dispose();
        });
        this.clearFactoryGuides();
        this.scene.environment = null;
        this.environmentRenderTarget?.dispose?.();
        this.environmentRenderTarget = null;
        this.environmentObjects.forEach((object) => {
            this.scene.remove(object);
            disposeObject3D(object);
        });
        this.environmentObjects = [];
        this.concreteTexture?.dispose?.();
        this.concreteTexture = null;

        // 销毁渲染器
        if (this.renderer) {
            if (this.renderer.domElement && this.boundOnWebglContextLost) {
                this.renderer.domElement.removeEventListener('webglcontextlost', this.boundOnWebglContextLost);
                this.renderer.domElement.removeEventListener('webglcontextrestored', this.boundOnWebglContextRestored);
            }
            this.renderer.dispose();
            this.renderer.forceContextLoss?.();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }
        
        // 移除 CSS2D 渲染器
        if (this.labelRenderer && this.labelRenderer.domElement && this.labelRenderer.domElement.parentNode) {
            this.labelRenderer.domElement.parentNode.removeChild(this.labelRenderer.domElement);
        }

        // 销毁 OrbitControls
        if (this.controls) {
            if (this.boundOnControlsStart) this.controls.removeEventListener('start', this.boundOnControlsStart);
            if (this.boundOnControlsChange) this.controls.removeEventListener('change', this.boundOnControlsChange);
            this.controls.dispose();
        }
    }
}
