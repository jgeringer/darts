import type { DetectorSignal } from '../types/darts'

type TensorFlowModule = typeof import('@tensorflow/tfjs')
type MobileNetModule = typeof import('@tensorflow-models/mobilenet')
type KNNModule = typeof import('@tensorflow-models/knn-classifier')
type MobileNetModel = Awaited<ReturnType<MobileNetModule['load']>>

type Label = 'dart_tip' | 'background'

const DATASET_STORAGE_KEY = 'dartvision.dartDetector.knn.v1'
const PATCH_SIZE = 96

let tfPromise: Promise<TensorFlowModule> | null = null
let mobilenetPromise: Promise<MobileNetModel> | null = null
let classifierPromise: Promise<ReturnType<KNNModule['create']>> | null = null

function getTf(): Promise<TensorFlowModule> {
  if (!tfPromise) {
    tfPromise = import('@tensorflow/tfjs')
  }
  return tfPromise
}

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      const knn = await import('@tensorflow-models/knn-classifier')
      return knn.create()
    })()
  }

  return classifierPromise
}

async function getMobileNet() {
  if (!mobilenetPromise) {
    mobilenetPromise = (async () => {
      const mobilenet = await import('@tensorflow-models/mobilenet')
      return (await mobilenet.load({ version: 2, alpha: 0.5 })) as MobileNetModel
    })()
  }

  return mobilenetPromise
}

function getPatchCanvas(source: HTMLCanvasElement, x: number, y: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = PATCH_SIZE
  canvas.height = PATCH_SIZE
  const context = canvas.getContext('2d')
  if (!context) {
    return canvas
  }

  const sx = Math.max(0, Math.min(source.width - PATCH_SIZE, x - PATCH_SIZE / 2))
  const sy = Math.max(0, Math.min(source.height - PATCH_SIZE, y - PATCH_SIZE / 2))
  context.drawImage(source, sx, sy, PATCH_SIZE, PATCH_SIZE, 0, 0, PATCH_SIZE, PATCH_SIZE)
  return canvas
}

async function getEmbedding(source: HTMLCanvasElement, x: number, y: number) {
  const model = await getMobileNet()
  const patch = getPatchCanvas(source, x, y)
  if (!model) {
    throw new Error('Dart detector model unavailable')
  }
  return model.infer(patch, true)
}

export async function addTrainingExample(
  source: HTMLCanvasElement,
  x: number,
  y: number,
  label: Label,
): Promise<void> {
  const classifier = await getClassifier()
  const embedding = await getEmbedding(source, x, y)

  classifier.addExample(embedding, label)
  embedding.dispose()
  await persistDataset()
}

export async function classifyPatch(
  source: HTMLCanvasElement,
  x: number,
  y: number,
): Promise<DetectorSignal[]> {
  const classifier = await getClassifier()
  if (classifier.getNumClasses() === 0) {
    return []
  }

  const embedding = await getEmbedding(source, x, y)
  const result = await classifier.predictClass(embedding, 3)
  embedding.dispose()

  return Object.entries(result.confidences).map(([label, score]) => ({
    label,
    score,
  }))
}

export async function getDetectorSummary(): Promise<{ dartTip: number; background: number }> {
  const classifier = await getClassifier()
  const counts = classifier.getClassExampleCount()
  return {
    dartTip: counts.dart_tip ?? 0,
    background: counts.background ?? 0,
  }
}

export async function clearDetectorDataset(): Promise<void> {
  const classifier = await getClassifier()
  classifier.clearAllClasses()
  localStorage.removeItem(DATASET_STORAGE_KEY)
}

export async function restoreDataset(): Promise<void> {
  const raw = localStorage.getItem(DATASET_STORAGE_KEY)
  if (!raw) {
    return
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, { data: number[]; shape: number[] }>
    const tf = await getTf()
    const classifier = await getClassifier()

    const dataset = Object.entries(parsed).reduce<Record<string, import('@tensorflow/tfjs').Tensor2D>>(
      (accumulator, [label, value]) => {
        const rows = value.shape[0]
        const cols = value.shape[1]
        if (!rows || !cols) {
          return accumulator
        }

        accumulator[label] = tf.tensor2d(value.data, [rows, cols])
        return accumulator
      },
      {},
    )

    classifier.setClassifierDataset(dataset)
  } catch {
    localStorage.removeItem(DATASET_STORAGE_KEY)
  }
}

async function persistDataset(): Promise<void> {
  const classifier = await getClassifier()
  const dataset = classifier.getClassifierDataset()
  const serialized: Record<string, { data: number[]; shape: number[] }> = {}

  Object.keys(dataset).forEach((label) => {
    const tensor = dataset[label]
    serialized[label] = {
      data: Array.from(tensor.dataSync()),
      shape: tensor.shape,
    }
  })

  localStorage.setItem(DATASET_STORAGE_KEY, JSON.stringify(serialized))
}
