import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MouseEvent } from 'react'
import './App.css'
import {
  ACTIVE_PROFILE_STORAGE_KEY,
  PROFILES_STORAGE_KEY,
  createDefaultProfile,
  loadActiveProfileId,
  loadProfiles,
  profileToRuntime,
  runtimeToProfile,
  type CalibrationProfile,
} from './lib/calibrationProfiles'
import {
  addTrainingExample,
  classifyPatch,
  clearDetectorDataset,
  getDetectorSummary,
  restoreDataset,
} from './lib/dartSpecificDetector'
import {
  DEFAULT_BOARD_DETECTION_CONFIG,
  detectBoardFromImageData,
  type BoardDetectionConfig,
} from './lib/boardDetection'
import { tuneBoardDetectionFromReferences } from './lib/boardReferenceTuning'
import { findMotionCandidate } from './lib/impactDetection'
import { defaultPerspectiveAnchors, normalizePointWithPerspective } from './lib/perspective'
import { scoreFromPoint } from './lib/scoreMapper'
import type { BoardCalibration, DetectorSignal, PerspectiveAnchors, Shot } from './types/darts'

type PendingReview = {
  x: number
  y: number
  cvConfidence: number
  aiConfidence: number
  finalConfidence: number
}

type DetectorCounts = {
  dartTip: number
  background: number
}

type BoardReferenceStatus = {
  loadedCount: number
  detectedCount: number
}

type WizardStep = 1 | 2 | 3 | 4

const SHOTS_STORAGE_KEY = 'dartvision.shots.v1'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isNearPoint(aX: number, aY: number, bX: number, bY: number, threshold: number): boolean {
  const dx = aX - bX
  const dy = aY - bY
  return dx * dx + dy * dy <= threshold * threshold
}

function nextAnchor(
  current: keyof PerspectiveAnchors | null,
): keyof PerspectiveAnchors | null {
  if (current === 'top') {
    return 'right'
  }

  if (current === 'right') {
    return 'bottom'
  }

  if (current === 'bottom') {
    return 'left'
  }

  return null
}

function loadPersistedShots(): Shot[] {
  try {
    const raw = localStorage.getItem(SHOTS_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as Shot[]
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.slice(0, 30)
  } catch {
    return []
  }
}

function getInitialProfilesState(): { profiles: CalibrationProfile[]; activeProfileId: string } {
  const profiles = loadProfiles()
  return {
    profiles,
    activeProfileId: loadActiveProfileId(profiles),
  }
}

function App() {
  const initialProfiles = getInitialProfilesState()

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const autoCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previousFrameRef = useRef<Uint8Array | null>(null)
  const shotsRef = useRef<Shot[]>([])
  const profilesRef = useRef<CalibrationProfile[]>(initialProfiles.profiles)
  const activeProfileIdRef = useRef<string>(initialProfiles.activeProfileId)
  const lastAutoShotRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const isProcessingFrameRef = useRef(false)

  const [streamError, setStreamError] = useState<string>('')
  const [isCameraReady, setIsCameraReady] = useState(false)
  const [isAutoDetectEnabled, setIsAutoDetectEnabled] = useState(false)
  const [isAiFusionEnabled, setIsAiFusionEnabled] = useState(true)
  const [isPerspectiveEnabled, setIsPerspectiveEnabled] = useState(true)

  const [motionThreshold, setMotionThreshold] = useState(28)
  const [minimumChangedPixels, setMinimumChangedPixels] = useState(170)
  const [autoCommitThreshold, setAutoCommitThreshold] = useState(0.66)

  const [videoSize, setVideoSize] = useState({ width: 960, height: 540 })
  const [shots, setShots] = useState<Shot[]>(loadPersistedShots)
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null)
  const [loopMotionScore, setLoopMotionScore] = useState(0)
  const [loopFinalConfidence, setLoopFinalConfidence] = useState(0)
  const [calibration, setCalibration] = useState<BoardCalibration>({
    centerX: 480,
    centerY: 270,
    radiusPx: 220,
    angleOffsetDeg: 0,
  })
  const [perspectiveAnchors, setPerspectiveAnchors] = useState<PerspectiveAnchors | null>(null)
  const [activeAnchorEdit, setActiveAnchorEdit] = useState<keyof PerspectiveAnchors | null>(null)

  const [profiles, setProfiles] = useState<CalibrationProfile[]>(initialProfiles.profiles)
  const [activeProfileId, setActiveProfileId] = useState<string>(initialProfiles.activeProfileId)
  const [newProfileName, setNewProfileName] = useState('')

  const [isDetecting, setIsDetecting] = useState(false)
  const [isBoardDetecting, setIsBoardDetecting] = useState(false)
  const [boardDetectProgress, setBoardDetectProgress] = useState(0)
  const [detectorSignals, setDetectorSignals] = useState<DetectorSignal[]>([])
  const [detectorCounts, setDetectorCounts] = useState<DetectorCounts>({ dartTip: 0, background: 0 })
  const [boardDetectionConfidence, setBoardDetectionConfidence] = useState<number | null>(null)
  const [boardDetectionConfig, setBoardDetectionConfig] = useState<BoardDetectionConfig>(
    DEFAULT_BOARD_DETECTION_CONFIG,
  )
  const [boardReferenceStatus, setBoardReferenceStatus] = useState<BoardReferenceStatus>({
    loadedCount: 0,
    detectedCount: 0,
  })
  const [isWizardActive, setIsWizardActive] = useState(false)
  const [wizardStep, setWizardStep] = useState<WizardStep>(1)
  const [wizardCenterSet, setWizardCenterSet] = useState(false)
  const [wizardRadiusConfirmed, setWizardRadiusConfirmed] = useState(false)
  const [wizardAnchorsPlaced, setWizardAnchorsPlaced] = useState(0)
  const [wizardProfileSaved, setWizardProfileSaved] = useState(false)
  const [wizardAutoAdvance, setWizardAutoAdvance] = useState(true)

  useEffect(() => {
    shotsRef.current = shots
  }, [shots])

  useEffect(() => {
    profilesRef.current = profiles
  }, [profiles])

  useEffect(() => {
    activeProfileIdRef.current = activeProfileId
  }, [activeProfileId])

  const activeProfile = useMemo(() => {
    return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null
  }, [activeProfileId, profiles])

  const applyProfileById = useCallback(
    (profileId: string, width: number, height: number) => {
      const profile = profiles.find((candidate) => candidate.id === profileId) ?? profiles[0]
      if (!profile) {
        return
      }

      const runtime = profileToRuntime(profile, width, height)
      setCalibration(runtime.calibration)
      setPerspectiveAnchors(runtime.perspective ?? defaultPerspectiveAnchors(runtime.calibration))
    },
    [profiles],
  )

  const normalizedPointForScore = useCallback(
    (x: number, y: number) => {
      if (!isPerspectiveEnabled) {
        return { x, y }
      }

      return normalizePointWithPerspective({ x, y }, calibration, perspectiveAnchors)
    },
    [calibration, isPerspectiveEnabled, perspectiveAnchors],
  )

  const refreshDetectorSummary = useCallback(async () => {
    const summary = await getDetectorSummary()
    setDetectorCounts(summary)
    return summary
  }, [])

  useEffect(() => {
    void restoreDataset().then(() => refreshDetectorSummary())
  }, [refreshDetectorSummary])

  useEffect(() => {
    const tuneFromReferences = async () => {
      const result = await tuneBoardDetectionFromReferences()
      setBoardDetectionConfig(result.config)
      setBoardReferenceStatus({
        loadedCount: result.loadedCount,
        detectedCount: result.detectedCount,
      })
    }

    void tuneFromReferences()
  }, [])

  useEffect(() => {
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles))
  }, [profiles])

  useEffect(() => {
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, activeProfileId)
  }, [activeProfileId])

  useEffect(() => {
    localStorage.setItem(SHOTS_STORAGE_KEY, JSON.stringify(shots.slice(0, 30)))
  }, [shots])

  useEffect(() => {
    let stream: MediaStream | null = null

    const setupCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })

        const video = videoRef.current
        if (!video) {
          return
        }

        video.srcObject = stream
        await video.play()

        const width = video.videoWidth || 960
        const height = video.videoHeight || 540
        setVideoSize({ width, height })

        const startupProfile =
          profilesRef.current.find((profile) => profile.id === activeProfileIdRef.current) ??
          profilesRef.current[0] ??
          createDefaultProfile()
        const runtime = profileToRuntime(startupProfile, width, height)
        setCalibration(runtime.calibration)
        setPerspectiveAnchors(runtime.perspective ?? defaultPerspectiveAnchors(runtime.calibration))

        setIsCameraReady(true)
      } catch (error) {
        setStreamError(
          error instanceof Error
            ? error.message
            : 'Could not open camera. Check browser permissions.',
        )
      }
    }

    void setupCamera()

    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
    }
  }, [])

  const runningTotal = useMemo(
    () => shots.reduce((sum, shot) => sum + shot.result.score, 0),
    [shots],
  )

  const isWizardStep1Complete = wizardCenterSet && wizardRadiusConfirmed
  const isWizardStep2Complete = wizardAnchorsPlaced >= 4 && !activeAnchorEdit
  const isWizardStep3Complete = detectorCounts.dartTip >= 3 && detectorCounts.background >= 3
  const isWizardStep4Complete = wizardProfileSaved

  const isCurrentWizardStepComplete =
    (wizardStep === 1 && isWizardStep1Complete) ||
    (wizardStep === 2 && isWizardStep2Complete) ||
    (wizardStep === 3 && isWizardStep3Complete) ||
    (wizardStep === 4 && isWizardStep4Complete)

  const wizardStepStatus = {
    step1: isWizardStep1Complete ? 'done' : wizardStep === 1 ? 'active' : 'todo',
    step2: isWizardStep2Complete ? 'done' : wizardStep === 2 ? 'active' : 'todo',
    step3: isWizardStep3Complete ? 'done' : wizardStep === 3 ? 'active' : 'todo',
    step4: isWizardStep4Complete ? 'done' : wizardStep === 4 ? 'active' : 'todo',
  }

  const maybeAutoAdvanceWizard = useCallback(
    (step: WizardStep, complete: boolean) => {
      if (!isWizardActive || !wizardAutoAdvance || !complete || wizardStep !== step) {
        return
      }

      if (step === 4) {
        setIsWizardActive(false)
        return
      }

      setWizardStep((current) => (current + 1) as WizardStep)
    },
    [isWizardActive, wizardAutoAdvance, wizardStep],
  )

  const startWizard = () => {
    setIsWizardActive(true)
    setWizardStep(1)
    setWizardCenterSet(false)
    setWizardRadiusConfirmed(false)
    setWizardAnchorsPlaced(0)
    setWizardProfileSaved(false)
    setIsPerspectiveEnabled(true)
    setActiveAnchorEdit(null)
  }

  const cancelWizard = () => {
    setIsWizardActive(false)
    setActiveAnchorEdit(null)
  }

  const nextWizardStep = () => {
    if (wizardStep === 4) {
      setIsWizardActive(false)
      return
    }

    const nextStep = (wizardStep + 1) as WizardStep
    if (wizardAutoAdvance && nextStep === 3 && isWizardStep3Complete) {
      setWizardStep(4)
      return
    }

    if (wizardAutoAdvance && nextStep === 4 && isWizardStep4Complete) {
      setIsWizardActive(false)
      return
    }

    setWizardStep(nextStep)
  }

  const boardStyle: CSSProperties = {
    width: '100%',
    aspectRatio: `${videoSize.width} / ${videoSize.height}`,
  }

  const addShotAt = useCallback((
    x: number,
    y: number,
    confidence = 0.95,
    source: Shot['source'] = 'manual',
  ) => {
    const point = normalizedPointForScore(x, y)
    const result = scoreFromPoint(point.x, point.y, calibration)
    const shot: Shot = {
      id: crypto.randomUUID(),
      x,
      y,
      confidence,
      source,
      result,
      createdAt: Date.now(),
    }

    setShots((current) => [shot, ...current].slice(0, 30))
  }, [calibration, normalizedPointForScore])

  const onOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top

    if (isWizardActive && wizardStep === 1) {
      setCalibration((current) => ({ ...current, centerX: x, centerY: y }))
      setWizardCenterSet(true)
      maybeAutoAdvanceWizard(1, wizardRadiusConfirmed)
      return
    }

    if (activeAnchorEdit) {
      setPerspectiveAnchors((current) => {
        const base = current ?? defaultPerspectiveAnchors(calibration)
        return {
          ...base,
          [activeAnchorEdit]: { x, y },
        }
      })
      if (isWizardActive && wizardStep === 2) {
        const placedCount = Math.min(4, wizardAnchorsPlaced + 1)
        setWizardAnchorsPlaced(placedCount)
        const willCompleteStep = nextAnchor(activeAnchorEdit) === null && placedCount >= 4
        maybeAutoAdvanceWizard(2, willCompleteStep)
      }
      setActiveAnchorEdit(nextAnchor(activeAnchorEdit))
      return
    }

    addShotAt(x, y)
  }

  const clearShots = () => setShots([])

  const removeLatestShot = () => {
    setShots((current) => current.slice(1))
  }

  const saveCurrentToActiveProfile = () => {
    if (!activeProfile || !isCameraReady) {
      return
    }

    const updated = runtimeToProfile(
      activeProfile,
      calibration,
      perspectiveAnchors,
      videoSize.width,
      videoSize.height,
    )

    setProfiles((current) => current.map((profile) => (profile.id === updated.id ? updated : profile)))
    if (isWizardActive && wizardStep === 4) {
      setWizardProfileSaved(true)
      maybeAutoAdvanceWizard(4, true)
    }
  }

  const createProfileFromCurrent = () => {
    if (!isCameraReady) {
      return
    }

    const baseName = newProfileName.trim() || `Mount ${profiles.length + 1}`
    const profile = runtimeToProfile(
      {
        ...createDefaultProfile(),
        id: crypto.randomUUID(),
        name: baseName,
      },
      calibration,
      perspectiveAnchors,
      videoSize.width,
      videoSize.height,
    )

    setProfiles((current) => [...current, profile])
    setActiveProfileId(profile.id)
    setNewProfileName('')
    if (isWizardActive && wizardStep === 4) {
      setWizardProfileSaved(true)
      maybeAutoAdvanceWizard(4, true)
    }
  }

  const deleteActiveProfile = () => {
    if (!activeProfile || profiles.length <= 1) {
      return
    }

    const nextProfiles = profiles.filter((profile) => profile.id !== activeProfile.id)
    setProfiles(nextProfiles)
    const nextId = nextProfiles[0]?.id ?? ''
    setActiveProfileId(nextId)
    if (isCameraReady && nextProfiles[0]) {
      const runtime = profileToRuntime(nextProfiles[0], videoSize.width, videoSize.height)
      setCalibration(runtime.calibration)
      setPerspectiveAnchors(runtime.perspective ?? defaultPerspectiveAnchors(runtime.calibration))
    }
  }

  const runDetectorProbe = async () => {
    const video = videoRef.current
    const canvas = probeCanvasRef.current
    if (!video || !canvas || !isCameraReady) {
      return
    }

    setIsDetecting(true)

    try {
      canvas.width = videoSize.width
      canvas.height = videoSize.height
      const context = canvas.getContext('2d')
      if (!context) {
        return
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const normalizedCenter = normalizedPointForScore(calibration.centerX, calibration.centerY)
      const signals = await classifyPatch(canvas, normalizedCenter.x, normalizedCenter.y)
      setDetectorSignals(signals.sort((a, b) => b.score - a.score).slice(0, 4))
      await refreshDetectorSummary()
    } finally {
      setIsDetecting(false)
    }
  }

  const autoDetectBoard = async () => {
    const video = videoRef.current
    const canvas = probeCanvasRef.current
    if (!video || !canvas || !isCameraReady) {
      return
    }

    setIsBoardDetecting(true)
    setBoardDetectProgress(0)

    try {
      const scanWidth = 360
      const scanHeight = Math.round((videoSize.height / videoSize.width) * scanWidth)
      canvas.width = scanWidth
      canvas.height = scanHeight

      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        return
      }

      const scanFrames = 12
      const frameDelayMs = 90
      let bestDetection: ReturnType<typeof detectBoardFromImageData> = null

      for (let frameIndex = 0; frameIndex < scanFrames; frameIndex += 1) {
        context.drawImage(video, 0, 0, scanWidth, scanHeight)
        const imageData = context.getImageData(0, 0, scanWidth, scanHeight)
        const detection = detectBoardFromImageData(imageData, boardDetectionConfig)

        if (!bestDetection || (detection && detection.confidence > bestDetection.confidence)) {
          bestDetection = detection
        }

        setBoardDetectProgress((frameIndex + 1) / scanFrames)
        if (frameIndex < scanFrames - 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, frameDelayMs)
          })
        }
      }

      if (!bestDetection) {
        setBoardDetectionConfidence(0)
        return
      }

      const scaleX = videoSize.width / scanWidth
      const scaleY = videoSize.height / scanHeight

      const nextCalibration: BoardCalibration = {
        centerX: bestDetection.centerX * scaleX,
        centerY: bestDetection.centerY * scaleY,
        radiusPx: bestDetection.radius * Math.max(scaleX, scaleY),
        angleOffsetDeg: calibration.angleOffsetDeg,
      }

      setCalibration(nextCalibration)
      setPerspectiveAnchors((current) => current ?? defaultPerspectiveAnchors(nextCalibration))
      setBoardDetectionConfidence(bestDetection.confidence)

      if (isWizardActive && wizardStep === 1) {
        setWizardCenterSet(true)
        setWizardRadiusConfirmed(true)
        maybeAutoAdvanceWizard(1, true)
      }
    } finally {
      setIsBoardDetecting(false)
      setBoardDetectProgress(0)
    }
  }

  const resetMotionHistory = () => {
    previousFrameRef.current = null
    lastAutoShotRef.current = null
    setPendingReview(null)
  }

  const confirmPendingReview = () => {
    if (!pendingReview) {
      return
    }

    addShotAt(pendingReview.x, pendingReview.y, pendingReview.finalConfidence, 'reviewed')
    lastAutoShotRef.current = { x: pendingReview.x, y: pendingReview.y, at: Date.now() }
    setPendingReview(null)
  }

  const rejectPendingReview = () => {
    setPendingReview(null)
  }

  const trainFromPending = async (label: 'dart_tip' | 'background') => {
    const canvas = autoCanvasRef.current
    if (!canvas || !pendingReview || videoSize.width <= 0 || videoSize.height <= 0) {
      return
    }

    const x = (pendingReview.x / videoSize.width) * canvas.width
    const y = (pendingReview.y / videoSize.height) * canvas.height
    await addTrainingExample(canvas, x, y, label)
    const summary = await refreshDetectorSummary()
    const detectorReady = summary.dartTip >= 3 && summary.background >= 3
    maybeAutoAdvanceWizard(3, detectorReady)
  }

  useEffect(() => {
    if (!isAutoDetectEnabled || !isCameraReady) {
      return
    }

    const video = videoRef.current
    const canvas = autoCanvasRef.current
    if (!video || !canvas) {
      return
    }

    let rafId = 0
    let shouldStop = false
    let lastTick = 0

    const processFrame = async () => {
      if (isProcessingFrameRef.current || shouldStop) {
        return
      }

      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        return
      }

      isProcessingFrameRef.current = true

      try {
        const width = 320
        const height = 180
        canvas.width = width
        canvas.height = height

        context.drawImage(video, 0, 0, width, height)
        const imageData = context.getImageData(0, 0, width, height)

        const motionResult = findMotionCandidate(
          imageData,
          previousFrameRef.current,
          calibration,
          videoSize.width / width,
          videoSize.height / height,
          {
            diffThreshold: motionThreshold,
            minChangedPixels: minimumChangedPixels,
          },
        )

        previousFrameRef.current = motionResult.currentFrame

        if (!motionResult.candidate) {
          return
        }

        const { x, y, motionScore } = motionResult.candidate
        setLoopMotionScore(motionScore)

        const now = Date.now()
        const lastAuto = lastAutoShotRef.current
        if (
          lastAuto &&
          now - lastAuto.at < 1200 &&
          isNearPoint(x, y, lastAuto.x, lastAuto.y, 22)
        ) {
          return
        }

        const tooNearExisting = shotsRef.current.some((shot) => isNearPoint(x, y, shot.x, shot.y, 18))
        if (tooNearExisting) {
          return
        }

        let aiConfidence = 0
        let signals: DetectorSignal[] = []

        if (isAiFusionEnabled) {
          const xInAutoCanvas = (x / videoSize.width) * width
          const yInAutoCanvas = (y / videoSize.height) * height
          signals = await classifyPatch(canvas, xInAutoCanvas, yInAutoCanvas)
          setDetectorSignals(signals.sort((a, b) => b.score - a.score).slice(0, 4))
          aiConfidence = signals.find((signal) => signal.label === 'dart_tip')?.score ?? 0
        }

        const cvConfidence = clamp(0.45 + motionScore * 0.45, 0, 1)
        const finalConfidence = clamp(cvConfidence * 0.75 + aiConfidence * 0.25, 0, 1)
        setLoopFinalConfidence(finalConfidence)

        if (finalConfidence >= autoCommitThreshold) {
          addShotAt(x, y, finalConfidence, 'auto')
          lastAutoShotRef.current = { x, y, at: now }
          setPendingReview(null)
          return
        }

        setPendingReview({
          x,
          y,
          cvConfidence,
          aiConfidence,
          finalConfidence,
        })
      } finally {
        isProcessingFrameRef.current = false
      }
    }

    const tick = async (time: number) => {
      if (shouldStop) {
        return
      }

      if (time - lastTick >= 120) {
        lastTick = time
        await processFrame()
      }

      rafId = requestAnimationFrame((next) => {
        void tick(next)
      })
    }

    rafId = requestAnimationFrame((time) => {
      void tick(time)
    })

    return () => {
      shouldStop = true
      cancelAnimationFrame(rafId)
    }
  }, [
    addShotAt,
    autoCommitThreshold,
    calibration,
    isAiFusionEnabled,
    isAutoDetectEnabled,
    isCameraReady,
    minimumChangedPixels,
    motionThreshold,
    videoSize.height,
    videoSize.width,
  ])

  const isAutoLoopRunning = isAutoDetectEnabled && isCameraReady

  return (
    <main className="app-shell">
      <header className="headline">
        <p className="eyebrow">browser-only scoring</p>
        <h1>Dart Vision</h1>
        <p>
          Perspective normalization, multi-mount calibration profiles, and a dart-specific detector
          are now active for stronger off-axis scoring and better confidence fusion.
        </p>
      </header>

      {streamError ? (
        <div className="card error-card">
          <strong>Camera unavailable.</strong>
          <p>{streamError}</p>
        </div>
      ) : null}

      <section className="layout-grid">
        <div className="card feed-card">
          <div className="board" style={boardStyle} onClick={onOverlayClick}>
            <video ref={videoRef} muted playsInline />
            <svg
              className="overlay"
              viewBox={`0 0 ${videoSize.width} ${videoSize.height}`}
              aria-label="Dart board overlay"
            >
              <circle
                cx={calibration.centerX}
                cy={calibration.centerY}
                r={calibration.radiusPx}
                className="ring"
              />
              <circle
                cx={calibration.centerX}
                cy={calibration.centerY}
                r={calibration.radiusPx * (162 / 170)}
                className="ring faint"
              />
              <circle
                cx={calibration.centerX}
                cy={calibration.centerY}
                r={calibration.radiusPx * (107 / 170)}
                className="ring faint"
              />
              <circle
                cx={calibration.centerX}
                cy={calibration.centerY}
                r={calibration.radiusPx * (99 / 170)}
                className="ring faint"
              />
              <circle
                cx={calibration.centerX}
                cy={calibration.centerY}
                r={calibration.radiusPx * (15.9 / 170)}
                className="ring faint"
              />
              <circle
                cx={calibration.centerX}
                cy={calibration.centerY}
                r={calibration.radiusPx * (6.35 / 170)}
                className="ring faint"
              />

              {perspectiveAnchors ? (
                <>
                  <line
                    x1={perspectiveAnchors.left.x}
                    y1={perspectiveAnchors.left.y}
                    x2={perspectiveAnchors.right.x}
                    y2={perspectiveAnchors.right.y}
                    className="anchor-line"
                  />
                  <line
                    x1={perspectiveAnchors.top.x}
                    y1={perspectiveAnchors.top.y}
                    x2={perspectiveAnchors.bottom.x}
                    y2={perspectiveAnchors.bottom.y}
                    className="anchor-line"
                  />
                  {(Object.keys(perspectiveAnchors) as Array<keyof PerspectiveAnchors>).map((key) => (
                    <g key={key}>
                      <circle
                        cx={perspectiveAnchors[key].x}
                        cy={perspectiveAnchors[key].y}
                        r={6}
                        className={`anchor-dot ${activeAnchorEdit === key ? 'active' : ''}`}
                      />
                      <text
                        x={perspectiveAnchors[key].x + 9}
                        y={perspectiveAnchors[key].y - 8}
                        className="shot-label"
                      >
                        {key}
                      </text>
                    </g>
                  ))}
                </>
              ) : null}

              {shots.map((shot, index) => (
                <g key={shot.id}>
                  <circle cx={shot.x} cy={shot.y} r={5} className="shot-dot" />
                  <text x={shot.x + 8} y={shot.y - 8} className="shot-label">
                    {index + 1}:{shot.result.score}
                  </text>
                </g>
              ))}
            </svg>
          </div>

          <p className="hint">
            {activeAnchorEdit
              ? `Click the board to place ${activeAnchorEdit} anchor.`
              : 'Click any board location to record a throw.'}
          </p>
        </div>

        <aside className="card controls-card">
          <h2>Calibration Wizard</h2>
          <div className="wizard-card">
            {!isWizardActive ? (
              <>
                <p className="hint">One-click guided setup: center/radius, perspective anchors, detector warm-up, then profile save.</p>
                <div className="button-row compact">
                  <button type="button" onClick={startWizard}>
                    Start guided calibration
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="wizard-step">Step {wizardStep} of 4</p>
                <ul className="wizard-progress-list">
                  <li className={`wizard-progress-item ${wizardStepStatus.step1}`}>
                    <span>1. Center and radius</span>
                    <strong>{wizardStepStatus.step1 === 'done' ? '[x]' : '[ ]'}</strong>
                  </li>
                  <li className={`wizard-progress-item ${wizardStepStatus.step2}`}>
                    <span>2. Perspective anchors</span>
                    <strong>{wizardStepStatus.step2 === 'done' ? '[x]' : '[ ]'}</strong>
                  </li>
                  <li className={`wizard-progress-item ${wizardStepStatus.step3}`}>
                    <span>3. Detector warm-up</span>
                    <strong>{wizardStepStatus.step3 === 'done' ? '[x]' : '[ ]'}</strong>
                  </li>
                  <li className={`wizard-progress-item ${wizardStepStatus.step4}`}>
                    <span>4. Save profile</span>
                    <strong>{wizardStepStatus.step4 === 'done' ? '[x]' : '[ ]'}</strong>
                  </li>
                </ul>
                <label className="checkbox-line wizard-toggle">
                  <input
                    type="checkbox"
                    checked={wizardAutoAdvance}
                    onChange={(event) => setWizardAutoAdvance(event.target.checked)}
                  />
                  Auto-advance when step is complete
                </label>
                {wizardStep === 1 ? (
                  <>
                    <p className="hint">Click the board center on the video, then tune radius with the slider and confirm.</p>
                    <p className="hint">Status: center {wizardCenterSet ? 'done' : 'waiting'}, radius {wizardRadiusConfirmed ? 'done' : 'waiting'}</p>
                    <div className="button-row compact">
                      <button
                        type="button"
                        onClick={() => {
                          setWizardRadiusConfirmed(true)
                          maybeAutoAdvanceWizard(1, wizardCenterSet)
                        }}
                      >
                        Confirm center and radius
                      </button>
                    </div>
                  </>
                ) : null}
                {wizardStep === 2 ? (
                  <>
                    <p className="hint">Place top, right, bottom, left anchors by clicking the board.</p>
                    <p className="hint">Status: {wizardAnchorsPlaced}/4 anchors placed</p>
                    <div className="button-row compact">
                      <button
                        type="button"
                        onClick={() => {
                          setPerspectiveAnchors((current) => current ?? defaultPerspectiveAnchors(calibration))
                          setActiveAnchorEdit('top')
                          setWizardAnchorsPlaced(0)
                        }}
                      >
                        Start anchor placement
                      </button>
                    </div>
                  </>
                ) : null}
                {wizardStep === 3 ? (
                  <>
                    <p className="hint">Label detector samples from review cards until both classes reach at least 3 samples.</p>
                    <p className="hint">Status: dart_tip {detectorCounts.dartTip}/3, background {detectorCounts.background}/3</p>
                  </>
                ) : null}
                {wizardStep === 4 ? (
                  <>
                    <p className="hint">Save calibration to the active profile or create a new profile for this mount.</p>
                    <p className="hint">Status: {wizardProfileSaved ? 'saved' : 'not saved yet'}</p>
                  </>
                ) : null}

                <div className="button-row compact">
                  <button type="button" onClick={nextWizardStep} disabled={!isCurrentWizardStepComplete}>
                    {wizardStep === 4 ? 'Finish wizard' : 'Next step'}
                  </button>
                  <button type="button" onClick={cancelWizard}>
                    Exit wizard
                  </button>
                </div>
              </>
            )}
          </div>

          <h2>Calibration Profiles</h2>
          <label>
            Active Profile
            <select
              value={activeProfileId}
              onChange={(event) => {
                const nextId = event.target.value
                setActiveProfileId(nextId)
                if (isCameraReady) {
                  applyProfileById(nextId, videoSize.width, videoSize.height)
                }
                resetMotionHistory()
              }}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <div className="profile-row">
            <input
              type="text"
              value={newProfileName}
              placeholder="New profile name"
              onChange={(event) => setNewProfileName(event.target.value)}
            />
            <button type="button" onClick={createProfileFromCurrent}>
              Create
            </button>
          </div>
          <div className="button-row compact">
            <button type="button" onClick={saveCurrentToActiveProfile} disabled={!activeProfile}>
              Save current to profile
            </button>
            <button type="button" onClick={deleteActiveProfile} disabled={profiles.length <= 1}>
              Delete active profile
            </button>
          </div>

          <h2>Board Calibration</h2>
          <div className="button-row compact">
            <button type="button" onClick={() => void autoDetectBoard()} disabled={!isCameraReady || isBoardDetecting}>
              {isBoardDetecting
                ? `Detecting board... ${Math.round(boardDetectProgress * 100)}%`
                : 'Auto-detect board'}
            </button>
          </div>
          {boardDetectionConfidence !== null ? (
            <p className="hint">
              Auto-detect confidence: {Math.round(boardDetectionConfidence * 100)}%
            </p>
          ) : null}
          <p className="hint">
            Reference images used: {boardReferenceStatus.detectedCount}/{boardReferenceStatus.loadedCount}
          </p>
          <label>
            Center X
            <input
              type="range"
              min={0}
              max={videoSize.width}
              step={1}
              value={calibration.centerX}
              onChange={(event) =>
                setCalibration((current) => ({
                  ...current,
                  centerX: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Center Y
            <input
              type="range"
              min={0}
              max={videoSize.height}
              step={1}
              value={calibration.centerY}
              onChange={(event) =>
                setCalibration((current) => ({
                  ...current,
                  centerY: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Board Radius (px)
            <input
              type="range"
              min={90}
              max={Math.max(150, Math.min(videoSize.width, videoSize.height) / 2)}
              step={1}
              value={calibration.radiusPx}
              onChange={(event) =>
                setCalibration((current) => ({
                  ...current,
                  radiusPx: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Angle Offset (deg)
            <input
              type="range"
              min={-18}
              max={18}
              step={0.1}
              value={calibration.angleOffsetDeg}
              onChange={(event) =>
                setCalibration((current) => ({
                  ...current,
                  angleOffsetDeg: Number(event.target.value),
                }))
              }
            />
          </label>

          <h2>Perspective Normalize</h2>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={isPerspectiveEnabled}
              onChange={(event) => setIsPerspectiveEnabled(event.target.checked)}
            />
            Enable perspective correction
          </label>
          <div className="button-row compact">
            <button
              type="button"
              onClick={() => {
                setPerspectiveAnchors((current) => current ?? defaultPerspectiveAnchors(calibration))
                setActiveAnchorEdit('top')
                if (isWizardActive && wizardStep === 2) {
                  setWizardAnchorsPlaced(0)
                }
              }}
            >
              Calibrate anchors (top/right/bottom/left)
            </button>
            <button
              type="button"
              onClick={() => {
                setPerspectiveAnchors(defaultPerspectiveAnchors(calibration))
                setActiveAnchorEdit(null)
              }}
            >
              Reset anchors
            </button>
          </div>

          <h2>Dart Detector</h2>
          <p className="hint">
            Small dart-specific classifier (MobileNet + KNN). Train with review samples to improve
            fusion quality for your board setup.
          </p>
          <button type="button" onClick={runDetectorProbe} disabled={!isCameraReady || isDetecting}>
            {isDetecting ? 'Running detector...' : 'Run detector probe'}
          </button>
          <p className="hint">
            Samples: dart_tip {detectorCounts.dartTip}, background {detectorCounts.background}
          </p>
          <div className="button-row compact">
            <button
              type="button"
              onClick={async () => {
                await clearDetectorDataset()
                setDetectorSignals([])
                await refreshDetectorSummary()
              }}
            >
              Clear detector samples
            </button>
          </div>

          <h2>Auto Detection</h2>
          <p className="hint">Motion loop runs around 8 FPS and fuses CV + dart-specific confidence.</p>
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                setIsAutoDetectEnabled((current) => !current)
                resetMotionHistory()
              }}
              disabled={!isCameraReady}
            >
              {isAutoDetectEnabled ? 'Stop auto detect' : 'Start auto detect'}
            </button>
          </div>
          <label>
            Motion Threshold
            <input
              type="range"
              min={10}
              max={60}
              step={1}
              value={motionThreshold}
              onChange={(event) => setMotionThreshold(Number(event.target.value))}
            />
          </label>
          <label>
            Min Changed Pixels
            <input
              type="range"
              min={50}
              max={420}
              step={5}
              value={minimumChangedPixels}
              onChange={(event) => setMinimumChangedPixels(Number(event.target.value))}
            />
          </label>
          <label>
            Auto Commit Threshold
            <input
              type="range"
              min={0.4}
              max={0.95}
              step={0.01}
              value={autoCommitThreshold}
              onChange={(event) => setAutoCommitThreshold(Number(event.target.value))}
            />
          </label>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={isAiFusionEnabled}
              onChange={(event) => setIsAiFusionEnabled(event.target.checked)}
            />
            Use dart-specific confidence fusion
          </label>
          <p className="hint">Loop: {isAutoLoopRunning ? 'running' : 'idle'}</p>
          <p className="hint">Motion score: {Math.round(loopMotionScore * 100)}%</p>
          <p className="hint">Final confidence: {Math.round(loopFinalConfidence * 100)}%</p>

          {pendingReview ? (
            <div className="pending-review">
              <strong>Review candidate throw</strong>
              <p>
                CV {Math.round(pendingReview.cvConfidence * 100)}%, AI{' '}
                {Math.round(pendingReview.aiConfidence * 100)}%, Final{' '}
                {Math.round(pendingReview.finalConfidence * 100)}%
              </p>
              <div className="button-row compact">
                <button type="button" onClick={confirmPendingReview}>
                  Confirm
                </button>
                <button type="button" onClick={rejectPendingReview}>
                  Reject
                </button>
                <button type="button" onClick={() => void trainFromPending('dart_tip')}>
                  Train as dart
                </button>
                <button type="button" onClick={() => void trainFromPending('background')}>
                  Train as background
                </button>
              </div>
            </div>
          ) : null}

          <ul className="detection-list">
            {detectorSignals.length === 0 ? <li>No detector signal yet.</li> : null}
            {detectorSignals.map((item) => (
              <li key={`${item.label}-${item.score}`}>
                {item.label} ({Math.round(item.score * 100)}%)
              </li>
            ))}
          </ul>

          <div className="button-row compact">
            <button type="button" onClick={removeLatestShot} disabled={shots.length === 0}>
              Undo shot
            </button>
            <button type="button" onClick={clearShots} disabled={shots.length === 0}>
              Clear shots
            </button>
          </div>
        </aside>
      </section>

      <section className="card score-card">
        <h2>Turn Summary</h2>
        <div className="running-total">{runningTotal}</div>
        <p className="hint">Latest throws are listed first. Low confidence throws can be corrected manually.</p>
        <ul className="shots-list">
          {shots.length === 0 ? <li>Waiting for first throw...</li> : null}
          {shots.map((shot) => (
            <li key={shot.id}>
              <strong>{shot.result.score}</strong>
              <span>
                {shot.result.ring}
                {shot.result.wedgeValue ? ` on ${shot.result.wedgeValue}` : ''}
              </span>
              <span>{Math.round(shot.confidence * 100)}% ({shot.source})</span>
            </li>
          ))}
        </ul>
      </section>

      <canvas ref={probeCanvasRef} className="hidden-canvas" />
      <canvas ref={autoCanvasRef} className="hidden-canvas" />
    </main>
  )
}

export default App
