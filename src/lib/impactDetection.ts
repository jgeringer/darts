import type { BoardCalibration } from '../types/darts'

export type MotionCandidate = {
  x: number
  y: number
  motionScore: number
}

export type MotionDetectionConfig = {
  diffThreshold: number
  minChangedPixels: number
}

const DEFAULT_CONFIG: MotionDetectionConfig = {
  diffThreshold: 30,
  minChangedPixels: 170,
}

function toGrayScaleFrame(imageData: ImageData): Uint8Array {
  const frame = new Uint8Array(imageData.width * imageData.height)
  const { data } = imageData

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    frame[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
  }

  return frame
}

export function findMotionCandidate(
  imageData: ImageData,
  previousFrame: Uint8Array | null,
  calibration: BoardCalibration,
  scaleX: number,
  scaleY: number,
  config: Partial<MotionDetectionConfig> = {},
): { currentFrame: Uint8Array; candidate: MotionCandidate | null } {
  const mergedConfig: MotionDetectionConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  }

  const currentFrame = toGrayScaleFrame(imageData)
  if (!previousFrame || previousFrame.length !== currentFrame.length) {
    return { currentFrame, candidate: null }
  }

  let changedPixels = 0
  let weightedMotion = 0
  let sumX = 0
  let sumY = 0

  const width = imageData.width
  const centerXScaled = calibration.centerX / scaleX
  const centerYScaled = calibration.centerY / scaleY
  const radiusScaled = calibration.radiusPx / Math.max(scaleX, scaleY)

  for (let i = 0; i < currentFrame.length; i += 1) {
    const diff = Math.abs(currentFrame[i] - previousFrame[i])
    if (diff < mergedConfig.diffThreshold) {
      continue
    }

    const x = i % width
    const y = Math.floor(i / width)

    const dx = x - centerXScaled
    const dy = y - centerYScaled
    if (dx * dx + dy * dy > radiusScaled * radiusScaled * 1.1) {
      continue
    }

    changedPixels += 1
    weightedMotion += diff
    sumX += x * diff
    sumY += y * diff
  }

  if (changedPixels < mergedConfig.minChangedPixels || weightedMotion === 0) {
    return { currentFrame, candidate: null }
  }

  const cx = sumX / weightedMotion
  const cy = sumY / weightedMotion

  return {
    currentFrame,
    candidate: {
      x: cx * scaleX,
      y: cy * scaleY,
      motionScore: Math.min(1, changedPixels / (mergedConfig.minChangedPixels * 3)),
    },
  }
}
