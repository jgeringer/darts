import type { BoardCalibration, Ring, ScoreResult } from '../types/darts'

const WEDGE_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]

const RING_RADII = {
  innerBull: 6.35 / 170,
  outerBull: 15.9 / 170,
  tripleInner: 99 / 170,
  tripleOuter: 107 / 170,
  doubleInner: 162 / 170,
  doubleOuter: 1,
}

function normalizeAngle(angleDeg: number): number {
  const normalized = angleDeg % 360
  return normalized < 0 ? normalized + 360 : normalized
}

export function scoreFromPoint(
  x: number,
  y: number,
  calibration: BoardCalibration,
): ScoreResult {
  const dx = x - calibration.centerX
  const dy = y - calibration.centerY
  const distance = Math.sqrt(dx * dx + dy * dy)
  const normalizedRadius = distance / calibration.radiusPx

  const rawAngle = (Math.atan2(dy, dx) * 180) / Math.PI
  const normalizedAngleDeg = normalizeAngle(rawAngle + 90 - calibration.angleOffsetDeg)

  if (normalizedRadius > RING_RADII.doubleOuter) {
    return {
      score: 0,
      ring: 'miss',
      wedgeValue: null,
      multiplier: 0,
      normalizedRadius,
      normalizedAngleDeg,
    }
  }

  if (normalizedRadius <= RING_RADII.innerBull) {
    return {
      score: 50,
      ring: 'innerBull',
      wedgeValue: null,
      multiplier: 1,
      normalizedRadius,
      normalizedAngleDeg,
    }
  }

  if (normalizedRadius <= RING_RADII.outerBull) {
    return {
      score: 25,
      ring: 'outerBull',
      wedgeValue: null,
      multiplier: 1,
      normalizedRadius,
      normalizedAngleDeg,
    }
  }

  const sectorIndex = Math.floor((normalizedAngleDeg + 9) / 18) % 20
  const wedgeValue = WEDGE_ORDER[sectorIndex]

  let ring: Ring = 'singleInner'
  let multiplier: 1 | 2 | 3 = 1

  if (normalizedRadius >= RING_RADII.doubleInner) {
    ring = 'double'
    multiplier = 2
  } else if (
    normalizedRadius >= RING_RADII.tripleInner &&
    normalizedRadius <= RING_RADII.tripleOuter
  ) {
    ring = 'triple'
    multiplier = 3
  } else if (normalizedRadius > RING_RADII.tripleOuter) {
    ring = 'singleOuter'
  }

  return {
    score: wedgeValue * multiplier,
    ring,
    wedgeValue,
    multiplier,
    normalizedRadius,
    normalizedAngleDeg,
  }
}
