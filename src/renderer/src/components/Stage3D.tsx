import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Box, Eye, Grid, Maximize2, RotateCcw, SlidersHorizontal, Video } from 'lucide-react'
import type { SnapshotDto } from '@shared/api'
import { CH, addressRange } from '@shared/dmx'
import { defaultLayerTransform, defaultModuleTransform } from '@shared/preset'
import { DEG2RAD, computeModuleBasePositions } from '@shared/stage3d'
import type { Layer, ModuleCfg } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

type CameraPreset = 'perspective' | 'front' | 'side' | 'top'

interface PositionedModule {
  mod: ModuleCfg
  baseX: number
}

interface LayerVisuals {
  group: THREE.Group
  beam: THREE.Mesh
  leftPillar: THREE.Mesh
  rightPillar: THREE.Mesh
  leftBase: THREE.Mesh
  rightBase: THREE.Mesh
}

interface ModuleMeshVisuals {
  rootGroup: THREE.Group
  winchBody: THREE.Mesh
  accentStrip: THREE.Mesh
  statusLed: THREE.Mesh
  curtainMesh: THREE.Mesh
  curtainBorder: THREE.LineSegments
  bottomBarGroup: THREE.Group
  leftCable: THREE.Mesh
  rightCable: THREE.Mesh
  selectionOutline: THREE.Mesh
  hitboxMesh: THREE.Mesh
  lastWidth: number
  lastLength: number
}

const RIGGING_TRUSS_HEIGHT = 3.6
const TRUSS_BEAM_Y = 0.16
const TRUSS_END_MARGIN = 0.72
const MIN_TRUSS_SPAN = 3.2
const BASE_FLOOR_MIN_X = -8.25
const BASE_FLOOR_MAX_X = 8.25
const BASE_FLOOR_MIN_Z = -3.75
const BASE_FLOOR_MAX_Z = 3.75
const FLOOR_MARGIN = 1.2

function buildFloorGridGeometry(minX: number, maxX: number, minZ: number, maxZ: number): THREE.BufferGeometry {
  const x0 = Math.floor(minX)
  const x1 = Math.ceil(maxX)
  const z0 = Math.floor(minZ)
  const z1 = Math.ceil(maxZ)
  const positions: number[] = []
  const colors: number[] = []
  const majorColor = new THREE.Color(0x3b2a1e)
  const minorColor = new THREE.Color(0x1b130f)

  const pushLine = (ax: number, az: number, bx: number, bz: number, isMajor: boolean) => {
    positions.push(ax, 0.005, az, bx, 0.005, bz)
    const c = isMajor ? majorColor : minorColor
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
  }

  for (let x = x0; x <= x1; x += 1) {
    pushLine(x, z0, x, z1, x === 0 || x % 4 === 0)
  }
  for (let z = z0; z <= z1; z += 1) {
    pushLine(x0, z, x1, z, z === 0 || z % 4 === 0)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geo
}

function computeLayerSpan(items: PositionedModule[]): { minX: number; maxX: number } {
  if (items.length === 0) return { minX: -MIN_TRUSS_SPAN / 2, maxX: MIN_TRUSS_SPAN / 2 }
  let minEdge = Number.POSITIVE_INFINITY
  let maxEdge = Number.NEGATIVE_INFINITY
  for (const { mod, baseX } of items) {
    const mtf = mod.transform ?? defaultModuleTransform()
    const halfW = (Math.max(0.3, mod.width) * Math.abs(mtf.scale[0])) / 2
    const cx = baseX + mtf.position[0]
    minEdge = Math.min(minEdge, cx - halfW)
    maxEdge = Math.max(maxEdge, cx + halfW)
  }
  let minX = minEdge - TRUSS_END_MARGIN
  let maxX = maxEdge + TRUSS_END_MARGIN
  const span = maxX - minX
  if (span < MIN_TRUSS_SPAN) {
    const pad = (MIN_TRUSS_SPAN - span) / 2
    minX -= pad
    maxX += pad
  }
  return { minX, maxX }
}

export function Stage3D() {
  const { project, selectedIds, snapshot, selectModule } = useAppStore()
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('perspective')
  const [showElevationRuler, setShowElevationRuler] = useState(true)
  const [hoveredModule, setHoveredModule] = useState<{
    id: string
    name: string
    pos: number
    length: number
    startAddress: number
  } | null>(null)

  const positioned = useMemo<PositionedModule[]>(() => {
    const baseMap = computeModuleBasePositions(project.layers, project.modules)
    return project.modules.map((mod) => ({ mod, baseX: baseMap.get(mod.id) ?? 0 }))
  }, [project.layers, project.modules])

  const positionedRef = useRef<PositionedModule[]>(positioned)
  const layersRef = useRef<Layer[]>(project.layers)
  const selectedIdsRef = useRef<string[]>(selectedIds)
  const snapshotRef = useRef<SnapshotDto | null>(snapshot)
  const lockValueRef = useRef<number>(project.settings.lockValue)
  const onSelectRef = useRef(selectModule)
  const rulerGroupRef = useRef<THREE.Group | null>(null)
  const cameraTargetPosRef = useRef<THREE.Vector3 | null>(null)
  const cameraTargetLookRef = useRef<THREE.Vector3 | null>(null)

  useEffect(() => {
    positionedRef.current = positioned
  }, [positioned])
  useEffect(() => {
    layersRef.current = project.layers
  }, [project.layers])
  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])
  useEffect(() => {
    lockValueRef.current = project.settings.lockValue
  }, [project.settings.lockValue])
  useEffect(() => {
    onSelectRef.current = selectModule
  }, [selectModule])
  useEffect(() => {
    if (rulerGroupRef.current) rulerGroupRef.current.visible = showElevationRuler
  }, [showElevationRuler])

  const applyCameraPreset = (preset: CameraPreset) => {
    setCameraPreset(preset)
    if (preset === 'perspective') {
      cameraTargetPosRef.current = new THREE.Vector3(7.5, 3.6, 8.8)
      cameraTargetLookRef.current = new THREE.Vector3(0, 2.0, 0)
    } else if (preset === 'front') {
      cameraTargetPosRef.current = new THREE.Vector3(0, 2.1, 9.8)
      cameraTargetLookRef.current = new THREE.Vector3(0, 2.1, 0)
    } else if (preset === 'side') {
      cameraTargetPosRef.current = new THREE.Vector3(10.5, 2.2, 0)
      cameraTargetLookRef.current = new THREE.Vector3(0, 2.1, 0)
    } else if (preset === 'top') {
      cameraTargetPosRef.current = new THREE.Vector3(0, 11.5, 0.8)
      cameraTargetLookRef.current = new THREE.Vector3(0, 1.5, 0)
    }
  }

  useEffect(() => {
    const container = mountRef.current
    if (!container) return

    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2')
      if (!gl) return true
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER
      const gpu = String(gl.getParameter(param))
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu)
    })()

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = !isSoftwareGl
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    const initialW = container.clientWidth || 800
    const initialH = container.clientHeight || 420
    renderer.setSize(initialW, initialH)
    container.innerHTML = ''
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0706)
    scene.fog = new THREE.FogExp2(0x0a0706, 0.03)

    const pmremGenerator = new THREE.PMREMGenerator(renderer)
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture
    pmremGenerator.dispose()

    const camera = new THREE.PerspectiveCamera(42, initialW / initialH, 0.1, 100)
    camera.position.set(7.5, 3.6, 8.8)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 2.0, 0)
    controls.enableDamping = !isSoftwareGl
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.495
    controls.minDistance = 2.5
    controls.maxDistance = 26

    const cancelCameraTransition = () => {
      cameraTargetPosRef.current = null
      cameraTargetLookRef.current = null
    }
    controls.addEventListener('start', cancelCameraTransition)

    // Ánh sáng 3 điểm
    const hemiLight = new THREE.HemisphereLight(0x8db8ff, 0x161d2a, 0.85)
    hemiLight.position.set(0, 10, 0)
    scene.add(hemiLight)

    const keyLight = new THREE.DirectionalLight(0xfff1e0, 2.1)
    keyLight.position.set(6, 9.5, 7)
    keyLight.castShadow = !isSoftwareGl
    keyLight.shadow.mapSize.set(1024, 1024)
    keyLight.shadow.camera.near = 0.5
    keyLight.shadow.camera.far = 25
    const d = 9
    keyLight.shadow.camera.left = -d
    keyLight.shadow.camera.right = d
    keyLight.shadow.camera.top = d
    keyLight.shadow.camera.bottom = -d
    keyLight.shadow.bias = -0.0005
    keyLight.shadow.normalBias = 0.02
    scene.add(keyLight)

    const rimLight = new THREE.DirectionalLight(0x8db8ff, 1.15)
    rimLight.position.set(-7, 6, -6)
    scene.add(rimLight)

    const warmStageSpot = new THREE.PointLight(0xf7842e, 1.4, 16)
    warmStageSpot.position.set(0, 4.5, 2.5)
    scene.add(warmStageSpot)

    // Sàn sân khấu & lưới ấm theo nền Kiln (tự động mở rộng theo toàn bộ Layer & chân cột)
    const stageDeck = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.14, 1),
      new THREE.MeshStandardMaterial({ color: 0x130d0a, roughness: 0.78, metalness: 0.18 }),
    )
    stageDeck.scale.set(BASE_FLOOR_MAX_X - BASE_FLOOR_MIN_X, 1, BASE_FLOOR_MAX_Z - BASE_FLOOR_MIN_Z)
    stageDeck.position.set(0, -0.07, 0)
    stageDeck.receiveShadow = true
    scene.add(stageDeck)

    const stageTrim = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.03, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0xf7842e,
        roughness: 0.35,
        metalness: 0.6,
        emissive: 0xf7842e,
        emissiveIntensity: 0.25,
      }),
    )
    stageTrim.scale.set(BASE_FLOOR_MAX_X - BASE_FLOOR_MIN_X + 0.02, 1, 1)
    stageTrim.position.set(0, 0.01, BASE_FLOOR_MAX_Z - 0.02)
    scene.add(stageTrim)

    let lastGridBounds = ''
    const floorGridMat = new THREE.LineBasicMaterial({ vertexColors: true })
    const floorGrid = new THREE.LineSegments(
      buildFloorGridGeometry(BASE_FLOOR_MIN_X, BASE_FLOOR_MAX_X, BASE_FLOOR_MIN_Z, BASE_FLOOR_MAX_Z),
      floorGridMat,
    )
    scene.add(floorGrid)

    // Texture dệt lưới màn gauze
    const createGauzeTexture = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'rgba(205, 225, 255, 0.22)'
      ctx.fillRect(0, 0, 256, 256)

      for (let x = 0; x < 256; x += 8) {
        const pleat = Math.sin((x / 256) * Math.PI * 8) * 20
        ctx.fillStyle = `rgba(${210 + pleat}, ${228 + pleat}, 255, 0.35)`
        ctx.fillRect(x, 0, 3, 256)
      }
      ctx.fillStyle = 'rgba(141, 184, 255, 0.28)'
      for (let y = 0; y < 256; y += 8) {
        ctx.fillRect(0, y, 256, 2)
      }

      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
      return tex
    }
    const gauzeTexture = createGauzeTexture()

    // Thước kẻ chiều cao
    const rulerGroup = new THREE.Group()
    const rulerMat = new THREE.LineDashedMaterial({
      color: 0x8db8ff,
      dashSize: 0.2,
      gapSize: 0.15,
      transparent: true,
      opacity: 0.35,
    })
    for (let dropM = 0; dropM <= 3; dropM += 1) {
      const yLevel = RIGGING_TRUSS_HEIGHT - dropM
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-7.4, yLevel, 1.2),
        new THREE.Vector3(7.4, yLevel, 1.2),
      ])
      const line = new THREE.Line(lineGeo, rulerMat)
      line.computeLineDistances()
      rulerGroup.add(line)
    }
    scene.add(rulerGroup)
    rulerGroupRef.current = rulerGroup

    // Vật liệu & hình khối cơ sở cho trụ chân cột và dầm truss theo từng Layer
    const towerPillarGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 12)
    const towerBaseGeo = new THREE.CylinderGeometry(0.22, 0.24, 0.04, 16)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.28 })

    const overheadTrussGeo = new THREE.BoxGeometry(1, 0.18, 0.18)
    const overheadTrussMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.88, roughness: 0.22 })

    const winchHousingMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.48, metalness: 0.55 })
    const clampMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.2, metalness: 0.9 })
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.25, metalness: 0.92 })
    const bottomWeightBarMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.35, metalness: 0.8 })

    // Phân cấp 3D: Scene -> LayerGroup (dầm truss + transform Layer) -> Module rootGroup (neo cạnh trên ở y=0)
    const layerGroupsMap = new Map<string, LayerVisuals>()
    const visualsMap = new Map<string, ModuleMeshVisuals>()
    const raycastTargets: THREE.Object3D[] = []
    const localAnchorLeft = new THREE.Vector3()
    const localAnchorRight = new THREE.Vector3()

    const getOrCreateLayerVisuals = (layerId: string): LayerVisuals => {
      let lv = layerGroupsMap.get(layerId)
      if (!lv) {
        const group = new THREE.Group()
        const beam = new THREE.Mesh(overheadTrussGeo, overheadTrussMat)
        beam.position.set(0, TRUSS_BEAM_Y, 0) // dính ngay trên điểm treo tời y=0
        group.add(beam)
        scene.add(group)

        const leftPillar = new THREE.Mesh(towerPillarGeo, towerMat)
        const rightPillar = new THREE.Mesh(towerPillarGeo, towerMat)
        const leftBase = new THREE.Mesh(towerBaseGeo, towerMat)
        const rightBase = new THREE.Mesh(towerBaseGeo, towerMat)
        scene.add(leftPillar, rightPillar, leftBase, rightBase)

        lv = { group, beam, leftPillar, rightPillar, leftBase, rightBase }
        layerGroupsMap.set(layerId, lv)
      }
      return lv
    }

    const createModuleVisual = (mod: ModuleCfg): ModuleMeshVisuals => {
      // Gốc tọa độ y=0 của rootGroup nằm đúng ở cạnh trên gắn vào Layer
      const rootGroup = new THREE.Group()
      const w = Math.max(0.3, mod.width)

      const winchBody = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.14, 0.14), winchHousingMat)
      winchBody.position.set(0, 0, 0)
      winchBody.castShadow = !isSoftwareGl
      rootGroup.add(winchBody)

      const clampGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.12, 10)
      const leftClamp = new THREE.Mesh(clampGeo, clampMat)
      leftClamp.position.set(-w * 0.34, 0.11, 0)
      const rightClamp = new THREE.Mesh(clampGeo, clampMat)
      rightClamp.position.set(w * 0.34, 0.11, 0)
      rootGroup.add(leftClamp, rightClamp)

      const accentStrip = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.88, 0.022, 0.01),
        new THREE.MeshStandardMaterial({
          color: 0x8db8ff,
          emissive: 0x8db8ff,
          emissiveIntensity: 0.4,
          roughness: 0.3,
        }),
      )
      accentStrip.position.set(0, 0, 0.073)
      rootGroup.add(accentStrip)

      const statusLed = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 0.9 }),
      )
      statusLed.position.set(w * 0.4, 0.03, 0.075)
      rootGroup.add(statusLed)

      const cableGeo = new THREE.CylinderGeometry(0.005, 0.005, 1, 6)
      const leftCable = new THREE.Mesh(cableGeo, cableMat)
      const rightCable = new THREE.Mesh(cableGeo, cableMat)
      rootGroup.add(leftCable, rightCable)

      const curtainGeo = new THREE.PlaneGeometry(w * 0.94, 1, 8, 8)
      const curtainMat = new THREE.MeshStandardMaterial({
        color: 0xdbeafe,
        map: gauzeTexture,
        transparent: true,
        opacity: 0.68,
        roughness: 0.65,
        metalness: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      const curtainMesh = new THREE.Mesh(curtainGeo, curtainMat)
      rootGroup.add(curtainMesh)

      const edgesGeo = new THREE.EdgesGeometry(curtainGeo)
      const borderMat = new THREE.LineBasicMaterial({ color: 0x8db8ff, transparent: true, opacity: 0.65 })
      const curtainBorder = new THREE.LineSegments(edgesGeo, borderMat)
      rootGroup.add(curtainBorder)

      const bottomBarGroup = new THREE.Group()
      const barGeo = new THREE.CylinderGeometry(0.022, 0.022, w * 0.96, 12)
      barGeo.rotateZ(Math.PI / 2)
      bottomBarGroup.add(new THREE.Mesh(barGeo, bottomWeightBarMat))

      const selectionOutline = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.96, 0.036, 0.05),
        new THREE.MeshStandardMaterial({
          color: 0xf7842e,
          emissive: 0xf7842e,
          emissiveIntensity: 0.8,
          transparent: true,
          opacity: 0,
        }),
      )
      bottomBarGroup.add(selectionOutline)
      rootGroup.add(bottomBarGroup)

      const hitboxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.98, Math.max(1.2, mod.length + 0.3), 0.24),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      hitboxMesh.position.set(0, -Math.max(1.2, mod.length) / 2, 0)
      hitboxMesh.userData = { moduleId: mod.id }
      rootGroup.add(hitboxMesh)
      raycastTargets.push(hitboxMesh)

      return {
        rootGroup,
        winchBody,
        accentStrip,
        statusLed,
        curtainMesh,
        curtainBorder,
        bottomBarGroup,
        leftCable,
        rightCable,
        selectionOutline,
        hitboxMesh,
        lastWidth: w,
        lastLength: mod.length,
      }
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let pointerDownPos = { x: 0, y: 0 }

    const handlePointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY }
    }

    const handlePointerUp = (e: PointerEvent) => {
      const dx = Math.abs(e.clientX - pointerDownPos.x)
      const dy = Math.abs(e.clientY - pointerDownPos.y)
      if (dx > 5 || dy > 5) return

      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

      raycaster.setFromCamera(pointer, camera)
      const intersects = raycaster.intersectObjects(raycastTargets, false)
      if (intersects.length > 0) {
        const hitModuleId = intersects[0].object.userData?.moduleId as string | undefined
        if (hitModuleId) {
          onSelectRef.current(hitModuleId, { multi: e.ctrlKey || e.metaKey, range: e.shiftKey })
        }
      }
    }

    let lastHoverCheck = 0
    const handlePointerMove = (e: PointerEvent) => {
      const now = performance.now()
      if (now - lastHoverCheck < 50) return
      lastHoverCheck = now

      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

      raycaster.setFromCamera(pointer, camera)
      const intersects = raycaster.intersectObjects(raycastTargets, false)
      if (intersects.length > 0) {
        const hitId = intersects[0].object.userData?.moduleId as string | undefined
        const found = positionedRef.current.find((p) => p.mod.id === hitId)?.mod
        if (found) {
          renderer.domElement.style.cursor = 'pointer'
          setHoveredModule({
            id: found.id,
            name: found.name,
            pos: snapshotRef.current?.modules[found.id]?.pos ?? 0,
            length: found.length,
            startAddress: found.startAddress,
          })
          return
        }
      }
      renderer.domElement.style.cursor = 'grab'
      setHoveredModule(null)
    }

    renderer.domElement.addEventListener('pointerdown', handlePointerDown)
    renderer.domElement.addEventListener('pointerup', handlePointerUp)
    renderer.domElement.addEventListener('pointermove', handlePointerMove)

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          camera.aspect = width / height
          camera.updateProjectionMatrix()
          renderer.setSize(width, height)
        }
      }
    })
    resizeObserver.observe(container)

    const clock = new THREE.Clock()
    let frameId = 0

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      gl.flush()
      const poll = () => {
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS)
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5)
        } else {
          gl.deleteSync(sync)
          frameId = window.setTimeout(cb, 80)
        }
      }
      frameId = window.setTimeout(poll, 5)
    }

    function tick() {
      const delta = Math.min(clock.getDelta(), 0.1)
      const currentItems = positionedRef.current
      const currentLayers = layersRef.current
      const selectedSet = new Set(selectedIdsRef.current)
      const snap = snapshotRef.current
      const isLocked = snap?.locked ?? true

      // Đồng bộ LayerGroups + transform 3D, dầm truss & chân cột theo thông số Layer/Module
      const activeLayerIds = new Set(currentLayers.map((l) => l.id))
      for (const [id, lv] of layerGroupsMap.entries()) {
        if (!activeLayerIds.has(id)) {
          scene.remove(lv.group, lv.leftPillar, lv.rightPillar, lv.leftBase, lv.rightBase)
          layerGroupsMap.delete(id)
        }
      }

      const itemsByLayer = new Map<string, PositionedModule[]>()
      for (const item of currentItems) {
        const list = itemsByLayer.get(item.mod.layerId) ?? []
        list.push(item)
        itemsByLayer.set(item.mod.layerId, list)
      }

      let pillarMinX = Number.POSITIVE_INFINITY
      let pillarMaxX = Number.NEGATIVE_INFINITY
      let pillarMinZ = Number.POSITIVE_INFINITY
      let pillarMaxZ = Number.NEGATIVE_INFINITY

      currentLayers.forEach((layer, idx) => {
        const lv = getOrCreateLayerVisuals(layer.id)
        const lg = lv.group
        const tf = layer.transform ?? defaultLayerTransform(idx)
        const visible = layer.visible ?? true
        lg.visible = visible
        lv.leftPillar.visible = visible
        lv.rightPillar.visible = visible
        lv.leftBase.visible = visible
        lv.rightBase.visible = visible

        lg.position.set(tf.position[0], tf.position[1], tf.position[2])
        lg.rotation.set(tf.rotation[0] * DEG2RAD, tf.rotation[1] * DEG2RAD, tf.rotation[2] * DEG2RAD)
        lg.scale.set(tf.scale[0], tf.scale[1], tf.scale[2])

        const { minX, maxX } = computeLayerSpan(itemsByLayer.get(layer.id) ?? [])
        const spanWidth = maxX - minX
        const centerX = (minX + maxX) / 2
        lv.beam.scale.set(spanWidth + 0.24, 1, 1)
        lv.beam.position.set(centerX, TRUSS_BEAM_Y, 0)

        lg.updateMatrixWorld(true)
        localAnchorLeft.set(minX, TRUSS_BEAM_Y, 0).applyMatrix4(lg.matrixWorld)
        localAnchorRight.set(maxX, TRUSS_BEAM_Y, 0).applyMatrix4(lg.matrixWorld)

        const hLeft = Math.max(0.2, localAnchorLeft.y + 0.14)
        lv.leftPillar.scale.set(1, hLeft, 1)
        lv.leftPillar.position.set(localAnchorLeft.x, hLeft / 2, localAnchorLeft.z)
        lv.leftBase.position.set(localAnchorLeft.x, 0.02, localAnchorLeft.z)

        const hRight = Math.max(0.2, localAnchorRight.y + 0.14)
        lv.rightPillar.scale.set(1, hRight, 1)
        lv.rightPillar.position.set(localAnchorRight.x, hRight / 2, localAnchorRight.z)
        lv.rightBase.position.set(localAnchorRight.x, 0.02, localAnchorRight.z)

        pillarMinX = Math.min(pillarMinX, localAnchorLeft.x, localAnchorRight.x)
        pillarMaxX = Math.max(pillarMaxX, localAnchorLeft.x, localAnchorRight.x)
        pillarMinZ = Math.min(pillarMinZ, localAnchorLeft.z, localAnchorRight.z)
        pillarMaxZ = Math.max(pillarMaxZ, localAnchorLeft.z, localAnchorRight.z)
      })

      const floorMinX = Number.isFinite(pillarMinX) ? Math.min(BASE_FLOOR_MIN_X, pillarMinX - FLOOR_MARGIN) : BASE_FLOOR_MIN_X
      const floorMaxX = Number.isFinite(pillarMaxX) ? Math.max(BASE_FLOOR_MAX_X, pillarMaxX + FLOOR_MARGIN) : BASE_FLOOR_MAX_X
      const floorMinZ = Number.isFinite(pillarMinZ) ? Math.min(BASE_FLOOR_MIN_Z, pillarMinZ - FLOOR_MARGIN) : BASE_FLOOR_MIN_Z
      const floorMaxZ = Number.isFinite(pillarMaxZ) ? Math.max(BASE_FLOOR_MAX_Z, pillarMaxZ + FLOOR_MARGIN) : BASE_FLOOR_MAX_Z
      const floorW = floorMaxX - floorMinX
      const floorD = floorMaxZ - floorMinZ
      const floorCX = (floorMinX + floorMaxX) / 2
      const floorCZ = (floorMinZ + floorMaxZ) / 2
      stageDeck.scale.set(floorW, 1, floorD)
      stageDeck.position.set(floorCX, -0.07, floorCZ)
      stageTrim.scale.set(floorW + 0.02, 1, 1)
      stageTrim.position.set(floorCX, 0.01, floorMaxZ - 0.02)

      const gridKey = `${Math.floor(floorMinX)},${Math.ceil(floorMaxX)},${Math.floor(floorMinZ)},${Math.ceil(floorMaxZ)}`
      if (gridKey !== lastGridBounds) {
        lastGridBounds = gridKey
        const nextGeo = buildFloorGridGeometry(floorMinX, floorMaxX, floorMinZ, floorMaxZ)
        floorGrid.geometry.dispose()
        floorGrid.geometry = nextGeo
      }

      // Dọn module bị xoá
      const activeIds = new Set(currentItems.map((p) => p.mod.id))
      for (const [id, vis] of visualsMap.entries()) {
        if (!activeIds.has(id)) {
          vis.rootGroup.parent?.remove(vis.rootGroup)
          const idx = raycastTargets.indexOf(vis.hitboxMesh)
          if (idx !== -1) raycastTargets.splice(idx, 1)
          visualsMap.delete(id)
        }
      }

      const layerVisMap = new Map(currentLayers.map((l) => [l.id, l.visible ?? true]))

      for (const { mod, baseX } of currentItems) {
        const lg = getOrCreateLayerVisuals(mod.layerId).group
        let vis = visualsMap.get(mod.id)
        if (!vis || Math.abs(vis.lastWidth - mod.width) > 0.01 || Math.abs(vis.lastLength - mod.length) > 0.01) {
          if (vis) {
            vis.rootGroup.parent?.remove(vis.rootGroup)
            const idx = raycastTargets.indexOf(vis.hitboxMesh)
            if (idx !== -1) raycastTargets.splice(idx, 1)
          }
          vis = createModuleVisual(mod)
          visualsMap.set(mod.id, vis)
        }

        if (vis.rootGroup.parent !== lg) lg.add(vis.rootGroup)

        const modVisible = (mod.visible ?? true) && (layerVisMap.get(mod.layerId) ?? true)
        vis.rootGroup.visible = modVisible
        if (!modVisible) continue

        // Transform của Module: cạnh trên (local y=0) luôn dính vào Layer
        const mtf = mod.transform ?? defaultModuleTransform()
        vis.rootGroup.position.set(baseX + mtf.position[0], 0, mtf.position[2])
        vis.rootGroup.rotation.set(
          mtf.rotation[0] * DEG2RAD,
          mtf.rotation[1] * DEG2RAD,
          mtf.rotation[2] * DEG2RAD,
        )
        vis.rootGroup.scale.set(mtf.scale[0], mtf.scale[1], mtf.scale[2])

        const modState = snap?.modules[mod.id]
        const pos = modState?.pos ?? 0
        const isMoving = modState?.moving ?? false

        const dropMeters = Math.max(0.04, pos)
        const topY = -0.07 // ngay dưới hộp tời (trên gốc 0 của module)
        const centerY = topY - dropMeters / 2
        const bottomY = topY - dropMeters

        vis.curtainMesh.scale.set(1, dropMeters, 1)
        vis.curtainMesh.position.set(0, centerY, 0)

        vis.curtainBorder.scale.set(1, dropMeters, 1)
        vis.curtainBorder.position.set(0, centerY, 0)

        vis.bottomBarGroup.position.set(0, bottomY, 0)

        const halfW = mod.width * 0.44
        vis.leftCable.scale.set(1, dropMeters, 1)
        vis.leftCable.position.set(-halfW, centerY, 0)
        vis.rightCable.scale.set(1, dropMeters, 1)
        vis.rightCable.position.set(halfW, centerY, 0)

        const isSelected = selectedSet.has(mod.id)
        const curtainMat = vis.curtainMesh.material as THREE.MeshStandardMaterial
        const borderMat = vis.curtainBorder.material as THREE.LineBasicMaterial
        const stripMat = vis.accentStrip.material as THREE.MeshStandardMaterial
        const selMat = vis.selectionOutline.material as THREE.MeshStandardMaterial
        const ledMat = vis.statusLed.material as THREE.MeshStandardMaterial

        if (isSelected) {
          curtainMat.color.setHex(0xffedd5)
          curtainMat.emissive.setHex(0xf7842e)
          curtainMat.emissiveIntensity = 0.24
          curtainMat.opacity = 0.82
          borderMat.color.setHex(0xf7842e)
          borderMat.opacity = 0.95
          stripMat.color.setHex(0xf7842e)
          stripMat.emissive.setHex(0xf7842e)
          stripMat.emissiveIntensity = 0.85
          selMat.opacity = 0.95
        } else {
          curtainMat.color.setHex(0xdbeafe)
          curtainMat.emissive.setHex(0x8db8ff)
          curtainMat.emissiveIntensity = 0.06
          curtainMat.opacity = 0.62
          borderMat.color.setHex(0x8db8ff)
          borderMat.opacity = 0.45
          stripMat.color.setHex(0x8db8ff)
          stripMat.emissive.setHex(0x8db8ff)
          stripMat.emissiveIntensity = 0.35
          selMat.opacity = 0
        }

        const lockCh4 = snap?.frame[mod.startAddress - 1 + CH.LOCK] ?? 0
        if (isLocked || lockCh4 !== lockValueRef.current) {
          ledMat.color.setHex(0xef4444)
          ledMat.emissive.setHex(0xef4444)
        } else if (isMoving) {
          ledMat.color.setHex(0xf7842e)
          ledMat.emissive.setHex(0xf7842e)
        } else {
          ledMat.color.setHex(0x22c55e)
          ledMat.emissive.setHex(0x22c55e)
        }
      }

      if (cameraTargetPosRef.current && cameraTargetLookRef.current) {
        const dampFactor = 1 - Math.exp(-6 * delta)
        camera.position.lerp(cameraTargetPosRef.current, dampFactor)
        controls.target.lerp(cameraTargetLookRef.current, dampFactor)
        if (
          camera.position.distanceTo(cameraTargetPosRef.current) < 0.03 &&
          controls.target.distanceTo(cameraTargetLookRef.current) < 0.03
        ) {
          cameraTargetPosRef.current = null
          cameraTargetLookRef.current = null
        }
      }

      controls.update()
      renderer.render(scene, camera)

      if (isSoftwareGl) afterDraw(tick)
      else frameId = requestAnimationFrame(tick)
    }

    if (!isSoftwareGl) renderer.compile(scene, camera)
    tick()

    return () => {
      cancelAnimationFrame(frameId)
      clearTimeout(frameId)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('pointerup', handlePointerUp)
      renderer.domElement.removeEventListener('pointermove', handlePointerMove)
      floorGrid.geometry.dispose()
      floorGridMat.dispose()
      controls.dispose()
      renderer.dispose()
    }
  }, [])

  const firstSelected = project.modules.find((m) => selectedIds.includes(m.id))
  const firstPos = firstSelected ? snapshot?.modules[firstSelected.id]?.pos ?? 0 : 0
  const baseIdx = firstSelected ? firstSelected.startAddress - 1 : -1
  const frame = snapshot?.frame
  const firstDmx =
    firstSelected && frame
      ? [
          frame[baseIdx + CH.POSITION] ?? 0,
          frame[baseIdx + CH.FINE] ?? 0,
          frame[baseIdx + CH.SPEED] ?? firstSelected.defaultSpeed,
          frame[baseIdx + CH.LOCK] ?? 0,
        ]
      : null

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[14px] bg-[#0A0706]">
      <div ref={mountRef} className="h-full w-full" />

      {/* Thông số nhanh góc trên trái */}
      <div className="pointer-events-none absolute top-2.5 left-2.5 z-10 flex flex-wrap items-center gap-2 rounded-full bg-[#150F0B]/90 px-3 py-1 text-[11px] shadow-[inset_0_0_0_1px_var(--line2)]">
        <span className="flex items-center gap-1.5 font-semibold text-brand">
          <Box className="h-3.5 w-3.5" />
          3D Stage
        </span>
        <span className="text-muted">·</span>
        <span className="text-[#C2B3A4] tabular-nums">
          Chọn: <strong className="text-info">{selectedIds.length}</strong>/{project.modules.length}
        </span>
        {firstSelected && firstDmx && (
          <>
            <span className="text-muted">·</span>
            <span className="text-[#C2B3A4] tabular-nums">
              {firstSelected.name}: <strong className="text-[#FFB26B]">{firstPos.toFixed(2)}m</strong> /{' '}
              {firstSelected.length.toFixed(1)}m
            </span>
            <span className="text-muted">·</span>
            <span className="font-mono text-info tabular-nums">
              CH {addressRange(firstSelected.startAddress).join('–')}: [{firstDmx.join(', ')}]
            </span>
          </>
        )}
      </div>

      {/* Badge khi di chuột qua module */}
      {hoveredModule && (
        <div className="pointer-events-none absolute bottom-2.5 left-2.5 z-10 flex items-center gap-2 rounded-full bg-[#150F0B]/95 px-3 py-1 text-xs shadow-[inset_0_0_0_1px_rgba(247,132,46,.5)]">
          <span className="font-semibold text-fg">{hoveredModule.name}</span>
          <span className="text-muted">·</span>
          <span className="font-mono text-[#FFB26B] tabular-nums">
            Cao: {hoveredModule.pos.toFixed(2)}m / {hoveredModule.length.toFixed(1)}m
          </span>
          <span className="text-muted">·</span>
          <span className="font-mono text-info tabular-nums">
            U{project.settings.output.universe}:{String(hoveredModule.startAddress).padStart(3, '0')}
          </span>
        </div>
      )}

      {/* Thanh chọn góc nhìn & thước mét dạng pill Kiln */}
      <div className="kiln-seg absolute top-2.5 right-2.5 z-10">
        <button
          type="button"
          title="Góc nhìn phối cảnh 3D"
          onClick={() => applyCameraPreset('perspective')}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full ${
            cameraPreset === 'perspective'
              ? 'bg-[linear-gradient(135deg,#FFC590_0%,#FF9442_50%,#F0701B_100%)] text-[#1C0E04]'
              : 'text-[#C2B3A4] hover:bg-white/10 hover:text-fg'
          }`}
        >
          <Video className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          title="Góc nhìn chính diện sân khấu"
          onClick={() => applyCameraPreset('front')}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full ${
            cameraPreset === 'front'
              ? 'bg-[linear-gradient(135deg,#FFC590_0%,#FF9442_50%,#F0701B_100%)] text-[#1C0E04]'
              : 'text-[#C2B3A4] hover:bg-white/10 hover:text-fg'
          }`}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          title="Góc nhìn ngang (So sánh 2 lớp màn)"
          onClick={() => applyCameraPreset('side')}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full ${
            cameraPreset === 'side'
              ? 'bg-[linear-gradient(135deg,#FFC590_0%,#FF9442_50%,#F0701B_100%)] text-[#1C0E04]'
              : 'text-[#C2B3A4] hover:bg-white/10 hover:text-fg'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          title="Góc nhìn từ trên xuống"
          onClick={() => applyCameraPreset('top')}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full ${
            cameraPreset === 'top'
              ? 'bg-[linear-gradient(135deg,#FFC590_0%,#FF9442_50%,#F0701B_100%)] text-[#1C0E04]'
              : 'text-[#C2B3A4] hover:bg-white/10 hover:text-fg'
          }`}
        >
          <Eye className="h-3.5 w-3.5" />
        </button>

        <div className="mx-0.5 h-4 w-[1px] bg-line" />

        <button
          type="button"
          title="Bật / Tắt thước lưới chiều cao (m)"
          onClick={() => setShowElevationRuler((v) => !v)}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full ${
            showElevationRuler ? 'bg-info/20 text-info' : 'text-muted hover:bg-white/10 hover:text-fg'
          }`}
        >
          <Grid className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          title="Đặt lại góc nhìn mặc định"
          onClick={() => applyCameraPreset('perspective')}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[#C2B3A4] hover:bg-white/10 hover:text-fg"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
