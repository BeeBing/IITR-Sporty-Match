// On-device people detection and pose, via MediaPipe. Two steps: find every person (works even
// for small, far-away players), then read each on-court player's pose from a zoomed-in crop.
import { FilesetResolver, ObjectDetector, PoseLandmarker } from '/vendor/mediapipe/vision_bundle.mjs';

const CROP = 256;

async function create(fileset, delegate) {
  const detector = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/efficientdet_lite0.tflite', delegate },
    runningMode: 'IMAGE',
    scoreThreshold: 0.3,
    categoryAllowlist: ['person'],
    maxResults: 16,
  });
  const pose = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate },
    runningMode: 'IMAGE',
    numPoses: 1,
    minPoseDetectionConfidence: 0.3,
    minPosePresenceConfidence: 0.3,
  });
  return { detector, pose };
}

export async function loadVision({ delegate = 'GPU' } = {}) {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  let models;
  try {
    models = await create(fileset, delegate);
  } catch (err) {
    if (delegate === 'CPU') throw err;
    delegate = 'CPU'; // some phones and browsers have no usable GPU path
    models = await create(fileset, delegate);
  }
  const crop = document.createElement('canvas');
  crop.width = CROP;
  crop.height = CROP;
  const cg = crop.getContext('2d');

  return {
    delegate,
    // Person boxes in source pixels: [{ box: [x, y, w, h], score }]
    people(source) {
      return models.detector.detect(source).detections.map((d) => ({
        box: [d.boundingBox.originX, d.boundingBox.originY, d.boundingBox.width, d.boundingBox.height],
        score: d.categories[0] ? d.categories[0].score : 0,
      }));
    },
    // Pose landmarks in source pixels for one person box, or null.
    pose(source, [x, y, w, h]) {
      const side = Math.max(w, h) * 1.3;
      const sx = x + w / 2 - side / 2;
      const sy = y + h / 2 - side / 2;
      cg.fillStyle = '#000';
      cg.fillRect(0, 0, CROP, CROP);
      cg.drawImage(source, sx, sy, side, side, 0, 0, CROP, CROP);
      const r = models.pose.detect(crop);
      if (!r.landmarks || !r.landmarks[0]) return null;
      return r.landmarks[0].map((q) => ({ x: sx + q.x * side, y: sy + q.y * side, v: q.visibility ?? 1 }));
    },
    close() {
      models.detector.close();
      models.pose.close();
    },
  };
}
