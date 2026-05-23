import type { ModelDetection } from '../types/darts'

type DetectionFrame = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageData

type CocoPrediction = {
  class: string
  score: number
  bbox: [number, number, number, number]
}

type CocoModel = {
  detect(frame: DetectionFrame): Promise<CocoPrediction[]>
}

let modelPromise: Promise<CocoModel> | null = null

export async function getDetector(): Promise<CocoModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      await import('@tensorflow/tfjs')
      const cocoSsd = await import('@tensorflow-models/coco-ssd')
      return cocoSsd.load({ base: 'lite_mobilenet_v2' }) as Promise<CocoModel>
    })()
  }

  return modelPromise
}

export async function detectFrame(frame: DetectionFrame): Promise<ModelDetection[]> {
  const model = await getDetector()
  const predictions = await model.detect(frame)

  return predictions.map((prediction) => ({
    className: prediction.class,
    score: prediction.score,
    bbox: prediction.bbox,
  }))
}
