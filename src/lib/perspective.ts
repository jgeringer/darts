import type { BoardCalibration, PerspectiveAnchors } from '../types/darts'

export type Point = {
  x: number
  y: number
}

function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function normalizePointWithPerspective(
  point: Point,
  calibration: BoardCalibration,
  anchors: PerspectiveAnchors | null,
): Point {
  if (!anchors) {
    return point
  }

  const centerFromVertical = midpoint(anchors.top, anchors.bottom)
  const centerFromHorizontal = midpoint(anchors.left, anchors.right)
  const center = midpoint(centerFromVertical, centerFromHorizontal)

  const rx = Math.max(24, distance(anchors.left, anchors.right) / 2)
  const ry = Math.max(24, distance(anchors.top, anchors.bottom) / 2)

  const normalizedX = (point.x - center.x) / rx
  const normalizedY = (point.y - center.y) / ry

  return {
    x: calibration.centerX + normalizedX * calibration.radiusPx,
    y: calibration.centerY + normalizedY * calibration.radiusPx,
  }
}

export function defaultPerspectiveAnchors(calibration: BoardCalibration): PerspectiveAnchors {
  const { centerX, centerY, radiusPx } = calibration
  return {
    top: { x: centerX, y: centerY - radiusPx },
    right: { x: centerX + radiusPx, y: centerY },
    bottom: { x: centerX, y: centerY + radiusPx },
    left: { x: centerX - radiusPx, y: centerY },
  }
}
