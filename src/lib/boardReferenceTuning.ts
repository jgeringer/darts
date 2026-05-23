import {
  DEFAULT_BOARD_DETECTION_CONFIG,
  detectBoardFromImageData,
  type BoardDetectionConfig,
} from './boardDetection'

type ReferenceManifest = {
  images: string[]
}

export type ReferenceTuningResult = {
  config: BoardDetectionConfig
  loadedCount: number
  detectedCount: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }

  return sorted[middle]
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load ${src}`))
    image.src = src
  })
}

async function loadManifest(): Promise<ReferenceManifest | null> {
  try {
    const response = await fetch('/dartBoardPhotos/manifest.json', { cache: 'no-cache' })
    if (!response.ok) {
      return null
    }

    const parsed = (await response.json()) as ReferenceManifest
    if (!Array.isArray(parsed.images)) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export async function tuneBoardDetectionFromReferences(): Promise<ReferenceTuningResult> {
  const manifest = await loadManifest()
  if (!manifest || manifest.images.length === 0) {
    return {
      config: DEFAULT_BOARD_DETECTION_CONFIG,
      loadedCount: 0,
      detectedCount: 0,
    }
  }

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return {
      config: DEFAULT_BOARD_DETECTION_CONFIG,
      loadedCount: 0,
      detectedCount: 0,
    }
  }

  const scanWidth = 420
  const radiusRatios: number[] = []
  const confidenceScores: number[] = []
  let loadedCount = 0
  let detectedCount = 0

  for (const fileName of manifest.images) {
    try {
      const image = await loadImage(`/dartBoardPhotos/${fileName}`)
      loadedCount += 1

      const scanHeight = Math.round((image.height / image.width) * scanWidth)
      canvas.width = scanWidth
      canvas.height = scanHeight

      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
      const detection = detectBoardFromImageData(imageData, {
        minConfidence: 0.1,
      })

      if (!detection) {
        continue
      }

      detectedCount += 1
      const minDim = Math.min(canvas.width, canvas.height)
      radiusRatios.push(detection.radius / minDim)
      confidenceScores.push(detection.confidence)
    } catch {
      // Ignore failed reference image and continue with remaining images.
    }
  }

  if (detectedCount === 0) {
    return {
      config: DEFAULT_BOARD_DETECTION_CONFIG,
      loadedCount,
      detectedCount,
    }
  }

  const medianRadiusRatio = median(radiusRatios)
  const medianConfidence = median(confidenceScores)

  const tunedConfig: BoardDetectionConfig = {
    minRadiusRatio: clamp(medianRadiusRatio - 0.12, 0.1, 0.5),
    maxRadiusRatio: clamp(medianRadiusRatio + 0.12, 0.2, 0.6),
    minConfidence: clamp(medianConfidence * 0.65, 0.12, 0.4),
  }

  return {
    config: tunedConfig,
    loadedCount,
    detectedCount,
  }
}
