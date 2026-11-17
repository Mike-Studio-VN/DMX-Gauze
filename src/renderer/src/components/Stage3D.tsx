import { useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { RotateCcw } from 'lucide-react'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { ModuleCfg } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

const TRUSS_Y = 3.6
const GAP = 0.08

interface GauzeMeshProps {
  mod: ModuleCfg
  x: number
  z: number
  pos: number
  selected: boolean
  isBack: boolean
  onSelect: (multi: boolean, range: boolean) => void
}

function GauzeMesh({ mod, x, z, pos, selected, isBack, onSelect }: GauzeMeshProps) {
  // Chiều cao thả tối thiểu 0.06m để luôn nhìn thấy cuộn màn dưới truss
  const drop = Math.max(0.06, pos)
  const centerY = TRUSS_Y - drop / 2
  const bottomY = TRUSS_Y - drop
  const color = selected ? '#F7842E' : isBack ? '#6ea2ff' : '#8DB8FF'

  return (
    <group position={[x, 0, z]}>
      {/* Điểm treo / hộp motor trên truss */}
      <mesh position={[0, TRUSS_Y + 0.06, 0]}>
        <boxGeometry args={[Math.min(0.28, mod.width * 0.8), 0.1, 0.14]} />
        <meshStandardMaterial color={selected ? '#F7842E' : '#334155'} metalness={0.5} roughness={0.4} />
      </mesh>

      {/* Tấm màn gauze bán trong suốt */}
      <mesh
        position={[0, centerY, 0]}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(e.nativeEvent.metaKey || e.nativeEvent.ctrlKey, e.nativeEvent.shiftKey)
        }}
      >
        <planeGeometry args={[mod.width, drop]} />
        <meshStandardMaterial
          color={color}
          transparent
          opacity={selected ? 0.82 : 0.48}
          side={2}
          roughness={0.6}
        />
      </mesh>

      {/* Thanh tạ đáy */}
      <mesh position={[0, bottomY, 0]}>
        <boxGeometry args={[mod.width, 0.04, 0.05]} />
        <meshStandardMaterial color={selected ? '#F7842E' : '#94a3b8'} metalness={0.6} roughness={0.3} />
      </mesh>
    </group>
  )
}

function SceneContent() {
  const { project, selectedIds, snapshot, selectModule } = useAppStore()

  const layout = useMemo(() => {
    const items: Array<{ mod: ModuleCfg; x: number; z: number; isBack: boolean }> = []
    project.layers.forEach((layer, layerIdx) => {
      const mods = project.modules.filter((m) => m.layerId === layer.id)
      const totalWidth = mods.reduce((acc, m) => acc + m.width, 0) + Math.max(0, mods.length - 1) * GAP
      let cursor = -totalWidth / 2
      const z = layerIdx === 0 ? 1.1 : -1.1
      mods.forEach((m) => {
        const x = cursor + m.width / 2
        cursor += m.width + GAP
        items.push({ mod: m, x, z, isBack: layerIdx > 0 })
      })
    })
    return items
  }, [project.layers, project.modules])

  const spanWidth = useMemo(() => {
    let maxW = 6
    project.layers.forEach((l) => {
      const mods = project.modules.filter((m) => m.layerId === l.id)
      const w = mods.reduce((acc, m) => acc + m.width, 0) + Math.max(0, mods.length - 1) * GAP + 1
      if (w > maxW) maxW = w
    })
    return maxW
  }, [project.layers, project.modules])

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[6, 10, 8]} intensity={1.1} />
      <directionalLight position={[-6, 4, -6]} intensity={0.4} color="#8DB8FF" />

      <Grid
        args={[24, 16]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#2a3342"
        sectionSize={3}
        sectionThickness={1}
        sectionColor="#3b475c"
        fadeDistance={28}
        position={[0, 0, 0]}
      />

      {/* Thanh truss cho từng lớp */}
      {project.layers.map((l, idx) => (
        <mesh key={l.id} position={[0, TRUSS_Y + 0.14, idx === 0 ? 1.1 : -1.1]}>
          <boxGeometry args={[spanWidth, 0.08, 0.14]} />
          <meshStandardMaterial color="#1e293b" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}

      {layout.map(({ mod, x, z, isBack }) => (
        <GauzeMesh
          key={mod.id}
          mod={mod}
          x={x}
          z={z}
          pos={snapshot?.modules[mod.id]?.pos ?? 0}
          selected={selectedIds.includes(mod.id)}
          isBack={isBack}
          onSelect={(multi, range) => selectModule(mod.id, { multi, range })}
        />
      ))}
    </>
  )
}

export function Stage3D() {
  const controlsRef = useRef<OrbitControlsImpl | null>(null)

  const resetCam = () => {
    if (!controlsRef.current) return
    controlsRef.current.object.position.set(0, 3.2, 11.5)
    controlsRef.current.target.set(0, 1.8, 0)
    controlsRef.current.update()
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg bg-bg">
      <Canvas camera={{ position: [0, 3.2, 11.5], fov: 42 }} dpr={[1, 2]}>
        <color attach="background" args={['#0b0e14']} />
        <SceneContent />
        <OrbitControls ref={controlsRef} target={[0, 1.8, 0]} maxPolarAngle={Math.PI / 2} minDistance={3} maxDistance={25} />
      </Canvas>

      <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="rounded bg-panel/85 px-2 py-0.5 backdrop-blur">
          Vị trí ước lượng · Trước (trước) / Sau (sau)
        </span>
      </div>

      <button
        type="button"
        onClick={resetCam}
        title="Đưa góc nhìn 3D về mặc định"
        className="absolute top-2 right-2 inline-flex cursor-pointer items-center gap-1 rounded-md border border-line bg-panel/85 px-2 py-1 text-xs text-muted hover:text-fg"
      >
        <RotateCcw size={13} aria-hidden />
        Góc chuẩn
      </button>
    </div>
  )
}
