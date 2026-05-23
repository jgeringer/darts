import type { BoardCalibration, PerspectiveAnchors } from '../types/darts'

export type CalibrationProfile = {
  id: string
  name: string
  centerXNorm: number
  centerYNorm: number
  radiusNorm: number
  angleOffsetDeg: number
  perspectiveAnchorsNorm: {
    top: { x: number; y: number }
    right: { x: number; y: number }
    bottom: { x: number; y: number }
    left: { x: number; y: number }
  } | null
}

export const PROFILES_STORAGE_KEY = 'dartvision.profiles.v1'
export const ACTIVE_PROFILE_STORAGE_KEY = 'dartvision.activeProfileId.v1'

export function createDefaultProfile(): CalibrationProfile {
  return {
    id: crypto.randomUUID(),
    name: 'Default Mount',
    centerXNorm: 0.5,
    centerYNorm: 0.5,
    radiusNorm: 0.42,
    angleOffsetDeg: 0,
    perspectiveAnchorsNorm: null,
  }
}

export function loadProfiles(): CalibrationProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY)
    if (!raw) {
      return [createDefaultProfile()]
    }

    const parsed = JSON.parse(raw) as CalibrationProfile[]
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [createDefaultProfile()]
    }

    return parsed
  } catch {
    return [createDefaultProfile()]
  }
}

export function loadActiveProfileId(profiles: CalibrationProfile[]): string {
  const raw = localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
  if (!raw) {
    return profiles[0]?.id ?? ''
  }

  const match = profiles.find((profile) => profile.id === raw)
  return match?.id ?? profiles[0]?.id ?? ''
}

export function profileToRuntime(
  profile: CalibrationProfile,
  videoWidth: number,
  videoHeight: number,
): { calibration: BoardCalibration; perspective: PerspectiveAnchors | null } {
  const minDim = Math.min(videoWidth, videoHeight)

  return {
    calibration: {
      centerX: profile.centerXNorm * videoWidth,
      centerY: profile.centerYNorm * videoHeight,
      radiusPx: profile.radiusNorm * minDim,
      angleOffsetDeg: profile.angleOffsetDeg,
    },
    perspective: profile.perspectiveAnchorsNorm
      ? {
          top: {
            x: profile.perspectiveAnchorsNorm.top.x * videoWidth,
            y: profile.perspectiveAnchorsNorm.top.y * videoHeight,
          },
          right: {
            x: profile.perspectiveAnchorsNorm.right.x * videoWidth,
            y: profile.perspectiveAnchorsNorm.right.y * videoHeight,
          },
          bottom: {
            x: profile.perspectiveAnchorsNorm.bottom.x * videoWidth,
            y: profile.perspectiveAnchorsNorm.bottom.y * videoHeight,
          },
          left: {
            x: profile.perspectiveAnchorsNorm.left.x * videoWidth,
            y: profile.perspectiveAnchorsNorm.left.y * videoHeight,
          },
        }
      : null,
  }
}

export function runtimeToProfile(
  profile: CalibrationProfile,
  calibration: BoardCalibration,
  perspective: PerspectiveAnchors | null,
  videoWidth: number,
  videoHeight: number,
): CalibrationProfile {
  const minDim = Math.min(videoWidth, videoHeight)

  return {
    ...profile,
    centerXNorm: calibration.centerX / videoWidth,
    centerYNorm: calibration.centerY / videoHeight,
    radiusNorm: calibration.radiusPx / minDim,
    angleOffsetDeg: calibration.angleOffsetDeg,
    perspectiveAnchorsNorm: perspective
      ? {
          top: { x: perspective.top.x / videoWidth, y: perspective.top.y / videoHeight },
          right: { x: perspective.right.x / videoWidth, y: perspective.right.y / videoHeight },
          bottom: { x: perspective.bottom.x / videoWidth, y: perspective.bottom.y / videoHeight },
          left: { x: perspective.left.x / videoWidth, y: perspective.left.y / videoHeight },
        }
      : null,
  }
}
