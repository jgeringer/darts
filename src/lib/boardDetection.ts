type BoardDetection = {
  centerX: number
  centerY: number
  radius: number
  confidence: number
}

export type BoardDetectionConfig = {
  minRadiusRatio: number
  maxRadiusRatio: number
  minConfidence: number
}

export const DEFAULT_BOARD_DETECTION_CONFIG: BoardDetectionConfig = {
  minRadiusRatio: 0.18,
  maxRadiusRatio: 0.48,
  minConfidence: 0.18,
}

type Candidate = {
  x: number
  y: number
  r: number
  score: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function buildGrayAndEdgeMap(imageData: ImageData): {
  gray: Uint8Array
  edge: Float32Array
  width: number
  height: number
} {
  const { width, height, data } = imageData
  const gray = new Uint8Array(width * height)

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)
  }

  const edge = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x
      const gx = gray[idx + 1] - gray[idx - 1]
      const gy = gray[idx + width] - gray[idx - width]
      edge[idx] = Math.sqrt(gx * gx + gy * gy)
    }
  }

  return { gray, edge, width, height }
}

function circleEdgeScore(
  edge: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  r: number,
  sampleStepDeg: number,
): number {
  let score = 0
  let samples = 0

  for (let angleDeg = 0; angleDeg < 360; angleDeg += sampleStepDeg) {
    const angleRad = (angleDeg * Math.PI) / 180
    const x = Math.round(cx + Math.cos(angleRad) * r)
    const y = Math.round(cy + Math.sin(angleRad) * r)

    if (x <= 0 || x >= width - 1 || y <= 0 || y >= height - 1) {
      continue
    }

    score += edge[y * width + x]
    samples += 1
  }

  if (samples === 0) {
    return 0
  }

  return score / samples
}

function searchBestCandidate(
  edge: Float32Array,
  width: number,
  height: number,
  minRadius: number,
  maxRadius: number,
): Candidate | null {
  let best: Candidate | null = null

  const coarseCenterStep = Math.max(8, Math.round(Math.min(width, height) / 28))
  const coarseRadiusStep = Math.max(5, Math.round((maxRadius - minRadius) / 16))

  for (let y = maxRadius; y <= height - maxRadius; y += coarseCenterStep) {
    for (let x = maxRadius; x <= width - maxRadius; x += coarseCenterStep) {
      for (let r = minRadius; r <= maxRadius; r += coarseRadiusStep) {
        const score = circleEdgeScore(edge, width, height, x, y, r, 20)
        if (!best || score > best.score) {
          best = { x, y, r, score }
        }
      }
    }
  }

  if (!best) {
    return null
  }

  let refined = best
  for (let y = best.y - 12; y <= best.y + 12; y += 3) {
    for (let x = best.x - 12; x <= best.x + 12; x += 3) {
      for (let r = Math.max(minRadius, best.r - 14); r <= Math.min(maxRadius, best.r + 14); r += 2) {
        const score = circleEdgeScore(edge, width, height, x, y, r, 10)
        if (score > refined.score) {
          refined = { x, y, r, score }
        }
      }
    }
  }

  return refined
}

function estimateConfidence(score: number): number {
  // Empirical edge-score normalization from camera frames in low-res search.
  return clamp((score - 10) / 35, 0, 1)
}

export function detectBoardFromImageData(
  imageData: ImageData,
  config: Partial<BoardDetectionConfig> = {},
): BoardDetection | null {
  const mergedConfig: BoardDetectionConfig = {
    ...DEFAULT_BOARD_DETECTION_CONFIG,
    ...config,
  }

  const { edge, width, height } = buildGrayAndEdgeMap(imageData)
  const minDim = Math.min(width, height)
  const minRadius = Math.round(minDim * mergedConfig.minRadiusRatio)
  const maxRadius = Math.round(minDim * mergedConfig.maxRadiusRatio)

  const best = searchBestCandidate(edge, width, height, minRadius, maxRadius)
  if (!best) {
    return null
  }

  const confidence = estimateConfidence(best.score)
  if (confidence < mergedConfig.minConfidence) {
    return null
  }

  return {
    centerX: best.x,
    centerY: best.y,
    radius: best.r,
    confidence,
  }
}
