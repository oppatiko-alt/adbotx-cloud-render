import {
  FaceLandmarker,
  FilesetResolver,
  ImageClassifier,
} from '@mediapipe/tasks-vision';

const DEFAULTS = {
  intervalMs: 400,
  maxWidth: 640,
  maxHeight: 480,
  smoothingWindow: 5,
  smoothingAlpha: 0.4,
  minConfidence: 0.35,
  maxSendIntervalMs: 1000,
  wasmBaseUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm',
  modelPaths: {
    faceLandmarker: '/models/face_landmarker.task',
    imageClassifier: '/models/image_classifier.task',
  },
};

const EMOTIONS = ['happy', 'angry', 'sad', 'neutral'];

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const avg = (...values) => {
  if (!values.length) return 0;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
};

const buildBlendshapeMap = (categories) => {
  const map = {};
  if (!categories) return map;
  categories.forEach((entry) => {
    if (entry?.categoryName) {
      map[entry.categoryName] = entry.score ?? 0;
    }
  });
  return map;
};

const majorityVote = (items, threshold) => {
  if (!items.length) return null;
  const counts = items.reduce((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
  let winner = null;
  let best = 0;
  Object.entries(counts).forEach(([emotion, count]) => {
    if (count > best) {
      best = count;
      winner = emotion;
    }
  });
  return best >= threshold ? winner : null;
};

const computeEmotionScores = (blendshapeMap) => {
  const get = (key) => blendshapeMap[key] || 0;
  const smile = avg(get('mouthSmileLeft'), get('mouthSmileRight'));
  const frown = avg(get('mouthFrownLeft'), get('mouthFrownRight'));
  const browDown = avg(get('browDownLeft'), get('browDownRight'));
  const browUp = get('browInnerUp');
  const eyeWide = avg(get('eyeWideLeft'), get('eyeWideRight'));
  const eyeSquint = avg(get('eyeSquintLeft'), get('eyeSquintRight'));
  const mouthPress = avg(get('mouthPressLeft'), get('mouthPressRight'));
  const noseSneer = avg(get('noseSneerLeft'), get('noseSneerRight'));
  const jawOpen = get('jawOpen');

  const happy = clamp01(
    smile * 1.3 + eyeSquint * 0.4 - frown * 0.7 - browDown * 0.2
  );
  const angry = clamp01(
    browDown * 1.1 + noseSneer * 0.8 + mouthPress * 0.5 + frown * 0.4 - smile * 0.3
  );
  const sad = clamp01(
    frown * 0.9 + browUp * 0.6 + mouthPress * 0.3 - smile * 0.4
  );

  const maxOther = Math.max(happy, angry, sad);
  const neutral = clamp01(1 - maxOther - eyeWide * 0.2 - jawOpen * 0.1);

  return { happy, angry, sad, neutral };
};

export default class PerceptionService {
  constructor(options) {
    this.videoEl = options.videoEl;
    this.onSignal = options.onSignal;
    this.onError = options.onError;
    this.intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
    this.maxWidth = options.maxWidth ?? DEFAULTS.maxWidth;
    this.maxHeight = options.maxHeight ?? DEFAULTS.maxHeight;
    this.smoothingWindow = options.smoothingWindow ?? DEFAULTS.smoothingWindow;
    this.smoothingAlpha = options.smoothingAlpha ?? DEFAULTS.smoothingAlpha;
    this.minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;
    this.maxSendIntervalMs = options.maxSendIntervalMs ?? DEFAULTS.maxSendIntervalMs;
    this.wasmBaseUrl = options.wasmBaseUrl ?? DEFAULTS.wasmBaseUrl;
    this.modelPaths = options.modelPaths ?? DEFAULTS.modelPaths;
    this.enableDemographics = options.enableDemographics ?? false;

    this.stream = null;
    this.timer = null;
    this.running = false;
    this.inflight = false;
    this.lastSentEmotion = null;
    this.lastSentAt = 0;
    this.history = [];
    this.emaScores = EMOTIONS.reduce((acc, key) => {
      acc[key] = 0;
      return acc;
    }, {});

    this.vision = null;
    this.faceLandmarker = null;
    this.imageClassifier = null;
    this.lastDemographicsAt = 0;
    this.demographics = { age_range: 'unknown', gender: 'unknown' };
  }

  isRunning() {
    return this.running;
  }

  async start() {
    if (this.running) return;
    if (!this.videoEl) throw new Error('Perception video element missing');

    this.running = true;
    await this._ensureModels();
    await this._ensureStream();

    this.timer = setInterval(() => {
      this._tick().catch((err) => this._handleError(err));
    }, this.intervalMs);
  }

  stop() {
    this.running = false;
    this.inflight = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
    }
  }

  async _ensureModels() {
    if (this.faceLandmarker) return;
    this.vision = await FilesetResolver.forVisionTasks(this.wasmBaseUrl);
    this.faceLandmarker = await FaceLandmarker.createFromOptions(this.vision, {
      baseOptions: { modelAssetPath: this.modelPaths.faceLandmarker },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });

    if (this.enableDemographics) {
      try {
        this.imageClassifier = await ImageClassifier.createFromOptions(this.vision, {
          baseOptions: { modelAssetPath: this.modelPaths.imageClassifier },
          runningMode: 'VIDEO',
        });
      } catch (err) {
        this.imageClassifier = null;
      }
    }
  }

  async _ensureStream() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: this.maxWidth },
        height: { ideal: this.maxHeight },
      },
      audio: false,
    });
    this.videoEl.srcObject = this.stream;
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    await this.videoEl.play();
  }

  async _tick() {
    if (!this.running || this.inflight) return;
    if (!this.videoEl || this.videoEl.readyState < 2) return;

    this.inflight = true;
    try {
      const now = performance.now();
      const result = this.faceLandmarker.detectForVideo(this.videoEl, now);
      const blendshapes = result.faceBlendshapes?.[0]?.categories || [];

      if (!blendshapes.length) {
        return;
      }

      const scores = computeEmotionScores(buildBlendshapeMap(blendshapes));
      EMOTIONS.forEach((key) => {
        const prev = this.emaScores[key] || 0;
        const next = scores[key] || 0;
        this.emaScores[key] = this.smoothingAlpha * next + (1 - this.smoothingAlpha) * prev;
      });

      let bestEmotion = 'neutral';
      let bestScore = 0;
      EMOTIONS.forEach((key) => {
        const value = this.emaScores[key] || 0;
        if (value > bestScore) {
          bestScore = value;
          bestEmotion = key;
        }
      });

      this.history.push(bestEmotion);
      if (this.history.length > this.smoothingWindow) {
        this.history.shift();
      }
      const majority = majorityVote(this.history, Math.ceil(this.smoothingWindow / 2));
      const finalEmotion = majority || bestEmotion;
      const finalConfidence = clamp01(this.emaScores[finalEmotion] || bestScore);

      if (this.imageClassifier && now - this.lastDemographicsAt > 2000) {
        this.lastDemographicsAt = now;
        this._updateDemographics(now);
      }

      this._maybeEmit(finalEmotion, finalConfidence);
    } finally {
      this.inflight = false;
    }
  }

  async _updateDemographics(now) {
    try {
      const result = this.imageClassifier.classifyForVideo(this.videoEl, now);
      const categories = result.classifications?.[0]?.categories || [];
      let gender = this.demographics.gender;
      let age_range = this.demographics.age_range;
      let genderScore = 0;
      let ageScore = 0;

      categories.forEach((entry) => {
        const label = (entry.categoryName || '').toLowerCase();
        const score = entry.score ?? 0;
        if (label.includes('female') && score > genderScore) {
          gender = 'female';
          genderScore = score;
        } else if (label.includes('male') && score > genderScore) {
          gender = 'male';
          genderScore = score;
        }

        if (label.includes('18') && label.includes('25') && score > ageScore) {
          age_range = '18-25';
          ageScore = score;
        } else if (label.includes('25') && label.includes('40') && score > ageScore) {
          age_range = '25-40';
          ageScore = score;
        } else if ((label.includes('40+') || label.includes('40')) && score > ageScore) {
          age_range = '40+';
          ageScore = score;
        }
      });

      this.demographics = { age_range, gender };
    } catch (err) {
      // Silent fail
    }
  }

  _maybeEmit(emotion, confidence) {
    if (confidence < this.minConfidence) return;
    const now = Date.now();
    const shouldSend =
      emotion !== this.lastSentEmotion || now - this.lastSentAt >= this.maxSendIntervalMs;

    if (!shouldSend || typeof this.onSignal !== 'function') return;
    this.lastSentEmotion = emotion;
    this.lastSentAt = now;

    this.onSignal({
      type: 'perception',
      emotion,
      age_range: this.demographics.age_range,
      gender: this.demographics.gender,
      confidence: Number(confidence.toFixed(2)),
      ts: Math.floor(now / 1000),
    });
  }

  _handleError(err) {
    if (!this.running) return;
    if (typeof this.onError === 'function') {
      this.onError(err);
    }
  }
}
