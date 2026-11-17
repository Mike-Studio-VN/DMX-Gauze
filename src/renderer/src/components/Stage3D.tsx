import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Box, Eye, Grid, Maximize2, RotateCcw, SlidersHorizontal, Video } from 'lucide-react'
import type { SnapshotDto } from '@shared/api'
import { CH, addressRange } from '@shared/dmx'
import { defaultLayerTransform, defaultModuleTransform } from '@shared/preset'
import type { Layer, ModuleCfg } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

type CameraPreset = 'perspective' | 'front' | 'side' | 'top'

interface PositionedModule {
  mod: ModuleCfg
  baseX: number
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
const MODULE_GAP = 0.08
const DEG2RAD = Math.PI / 180

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
    const out: PositionedModule[] = []
    project.layers.forEach((layer) => {
      const mods = project.modules.filter((m) => m.layerId === layer.id)
      const totalWidth = mods.reduce((acc, m) => acc + m.width, 0) + Math.max(0, mods.length - 1) * MODULE_GAP
      let cursor = -totalWidth / 2
      mods.forEach((mod) => {
        const baseX = cursor + mod.width / 2
        cursor += mod.width + MODULE_GAP
        out.push({ mod, baseX })
      })
    })
    return out
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

    // Sàn sân khấu & lưới ấm theo nền Kiln
    const stageDeck = new THREE.Mesh(
      new THREE.BoxGeometry(16.5, 0.14, 7.5),
      new THREE.MeshStandardMaterial({ color: 0x130d0a, roughness: 0.78, metalness: 0.18 }),
    )
    stageDeck.position.set(0, -0.07, 0)
    stageDeck.receiveShadow = true
    scene.add(stageDeck)

    const stageTrim = new THREE.Mesh(
      new THREE.BoxGeometry(16.52, 0.03, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0xf7842e,
        roughness: 0.35,
        metalness: 0.6,
        emissive: 0xf7842e,
        emissiveIntensity: 0.25,
      }),
    )
    stageTrim.position.set(0, 0.01, 3.73)
    scene.add(stageTrim)

    const gridHelper = new THREE.GridHelper(16, 16, 0x3b2a1e, 0x1b130f)
    gridHelper.position.y = 0.005
    scene.add(gridHelper)

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

    // Trụ truss hai bên sân khấu
    const towerPillarGeo = new THREE.CylinderGeometry(0.08, 0.08, RIGGING_TRUSS_HEIGHT + 0.3, 12)
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.28 })
    ;[-7.6, 7.6].forEach((xPos) => {
      ;[1.2, -1.4].forEach((zPos) => {
        const pillar = new THREE.Mesh(towerPillarGeo, towerMat)
        pillar.position.set(xPos, (RIGGING_TRUSS_HEIGHT + 0.3) / 2, zPos)
        scene.add(pillar)
      })
    })

    const overheadTrussGeo = new THREE.BoxGeometry(15.4, 0.18, 0.18)
    const overheadTrussMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.88, roughness: 0.22 })

    const winchHousingMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.48, metalness: 0.55 })
    const clampMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.2, metalness: 0.9 })
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.25, metalness: 0.92 })
    const bottomWeightBarMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.35, metalness: 0.8 })

    // Phân cấp 3D: Scene -> LayerGroup (dầm truss + transform Layer) -> Module rootGroup (neo cạnh trên ở y=0)
    const layerGroupsMap = new Map<string, THREE.Group>()
    const visualsMap = new Map<string, ModuleMeshVisuals>()
    const raycastTargets: THREE.Object3D[] = []

    const getOrCreateLayerGroup = (layerId: string): THREE.Group => {
      let g = layerGroupsMap.get(layerId)
      if (!g) {
        g = new THREE.Group()
        const beam = new THREE.Mesh(overheadTrussGeo, overheadTrussMat)
        beam.position.set(0, 0.16, 0) // dính ngay trên điểm treo tời y=0
        g.add(beam)
        scene.add(g)
        layerGroupsMap.set(layerId, g)
      }
      return g
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

      // Đồng bộ LayerGroups + transform 3D & visible
      const activeLayerIds = new Set(currentLayers.map((l) => l.id))
      for (const [id, lg] of layerGroupsMap.entries()) {
        if (!activeLayerIds.has(id)) {
          scene.remove(lg)
          layerGroupsMap.delete(id)
        }
      }
      currentLayers.forEach((layer, idx) => {
        const lg = getOrCreateLayerGroup(layer.id)
        const tf = layer.transform ?? defaultLayerTransform(idx)
        lg.visible = layer.visible ?? true
        lg.position.set(tf.position[0], tf.position[1], tf.position[2])
        lg.rotation.set(tf.rotation[0] * DEG2RAD, tf.rotation[1] * DEG2RAD, tf.rotation[2] * DEG2RAD)
        lg.scale.set(tf.scale[0], tf.scale[1], tf.scale[2])
      })

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
        const lg = getOrCreateLayerGroup(mod.layerId)
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
