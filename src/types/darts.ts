export type BoardCalibration = {
  centerX: number
  centerY: number
  radiusPx: number
  angleOffsetDeg: number
}

export type PerspectiveAnchors = {
  top: { x: number; y: number }
  right: { x: number; y: number }
  bottom: { x: number; y: number }
  left: { x: number; y: number }
}

export type Ring =
  | 'miss'
  | 'singleInner'
  | 'triple'
  | 'singleOuter'
  | 'double'
  | 'outerBull'
  | 'innerBull'

export type ScoreResult = {
  score: number
  ring: Ring
  wedgeValue: number | null
  multiplier: 0 | 1 | 2 | 3
  normalizedRadius: number
  normalizedAngleDeg: number
}

export type Shot = {
  id: string
  x: number
  y: number
  result: ScoreResult
  confidence: number
  source: 'manual' | 'auto' | 'reviewed'
  createdAt: number
}

export type ModelDetection = {
  className: string
  score: number
  bbox: [number, number, number, number]
}

export type DetectorSignal = {
  label: string
  score: number
}
