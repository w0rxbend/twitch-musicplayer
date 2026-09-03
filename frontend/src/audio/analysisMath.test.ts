/* Tests for the two analyser reductions.
 *
 * Run with:  npm test          (node --test, no extra dependencies)
 *
 * These run in plain Node with no browser and no audio device: the functions
 * under test are pure, and a synthetic signal is more precise for checking the
 * maths than anything a real track could provide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLogBands, reduceEnvelope } from './analysisMath.ts';

const RATE = 44100;
const FFT = 2048;
const BANDS = 64;
const MIN_HZ = 30;
const MAX_HZ = 16000;

/** Which FFT bin a frequency lands in, for the transform size used here. */
const binOf = (hz: number) => Math.round(hz / (RATE / FFT));

test('every band covers at least one bin', () => {
  const { lo, hi } = buildLogBands(RATE, FFT, BANDS, MIN_HZ, MAX_HZ);
  for (let i = 0; i < BANDS; i++) {
    assert.ok(hi[i] > lo[i], `band ${i} is empty: [${lo[i]}, ${hi[i]})`);
  }
});

test('bands ascend and stay inside the spectrum', () => {
  const { lo, hi } = buildLogBands(RATE, FFT, BANDS, MIN_HZ, MAX_HZ);
  const binCount = FFT / 2;
  for (let i = 0; i < BANDS; i++) {
    assert.ok(lo[i] >= 0 && hi[i] <= binCount, `band ${i} out of range`);
    if (i > 0) assert.ok(lo[i] >= lo[i - 1], `band ${i} starts before its predecessor`);
  }
});

test('bands are spaced logarithmically, so high bands are wider in bins', () => {
  const { lo, hi } = buildLogBands(RATE, FFT, BANDS, MIN_HZ, MAX_HZ);
  const width = (i: number) => hi[i] - lo[i];
  // The top band should cover far more bins than the bottom one. That is the
  // whole point: equal screen width per octave, not per hertz.
  assert.ok(
    width(BANDS - 1) > width(0) * 10,
    `expected the top band to be much wider: ${width(0)} vs ${width(BANDS - 1)}`,
  );
});

test('a 1 kHz tone lands in a band near the middle of the display', () => {
  const { lo, hi } = buildLogBands(RATE, FFT, BANDS, MIN_HZ, MAX_HZ);
  const bin = binOf(1000);

  const hits: number[] = [];
  for (let i = 0; i < BANDS; i++) {
    if (bin >= lo[i] && bin < hi[i]) hits.push(i);
  }
  assert.ok(hits.length > 0, '1 kHz fell outside every band');

  // 1 kHz sits about 56% of the way from 30 Hz to 16 kHz on a log scale, so it
  // belongs near the centre. On a linear scale it would be at 6%, jammed
  // against the left edge — which is the behaviour this mapping exists to fix.
  const position = hits[0] / BANDS;
  assert.ok(
    position > 0.45 && position < 0.7,
    `1 kHz mapped to band ${hits[0]} of ${BANDS} (position ${position.toFixed(2)})`,
  );
});

test('envelope reduction recovers the true amplitude of a loud tone', () => {
  // A full-scale sine at an awkward frequency, so buckets do not align with
  // whole cycles.
  const samples = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) samples[i] = Math.sin((i / RATE) * 2 * Math.PI * 997);

  // 64 samples per bucket, against a cycle of about 44 samples: every bucket
  // spans at least one full oscillation and so must contain both peaks. A
  // bucket narrower than half a cycle legitimately sees only one side of the
  // waveform, which is a property of the signal rather than of the reduction.
  const buckets = 32;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  reduceEnvelope(samples, buckets, min, max, rms);

  for (let i = 0; i < buckets; i++) {
    assert.ok(max[i] > 0.9, `bucket ${i} lost the positive peak: ${max[i]}`);
    assert.ok(min[i] < -0.9, `bucket ${i} lost the negative peak: ${min[i]}`);
    // RMS of a full-scale sine is 1/sqrt(2).
    assert.ok(
      Math.abs(rms[i] - Math.SQRT1_2) < 0.06,
      `bucket ${i} rms ${rms[i].toFixed(3)} should be near ${Math.SQRT1_2.toFixed(3)}`,
    );
  }
});

test('envelope reduction beats point sampling on the same signal', () => {
  const samples = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) samples[i] = Math.sin((i / RATE) * 2 * Math.PI * 997);

  const buckets = 32;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  reduceEnvelope(samples, buckets, min, max, rms);

  // What a naive implementation would draw: every Nth sample.
  const stride = FFT / buckets;
  let pointSampledWeakest = Infinity;
  for (let i = 0; i < buckets; i++) {
    pointSampledWeakest = Math.min(pointSampledWeakest, Math.abs(samples[i * stride]));
  }

  let envelopeWeakest = Infinity;
  for (let i = 0; i < buckets; i++) {
    envelopeWeakest = Math.min(envelopeWeakest, Math.max(Math.abs(min[i]), Math.abs(max[i])));
  }

  // Point sampling drops close to zero wherever it happens to catch a zero
  // crossing, which is what makes a naive waveform flicker. The envelope never
  // collapses like that.
  assert.ok(
    envelopeWeakest > pointSampledWeakest * 5,
    `envelope floor ${envelopeWeakest.toFixed(3)} should far exceed point-sampled floor ${pointSampledWeakest.toFixed(3)}`,
  );
});

test('silence reduces to zeroes rather than to infinities', () => {
  const samples = new Float32Array(512); // all zero
  const buckets = 64;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  reduceEnvelope(samples, buckets, min, max, rms);

  for (let i = 0; i < buckets; i++) {
    assert.equal(min[i], 0);
    assert.equal(max[i], 0);
    assert.equal(rms[i], 0);
  }
});

test('more buckets than samples does not produce garbage', () => {
  // Guards the Infinity sentinels leaking out when a bucket ends up empty.
  const samples = new Float32Array(16).fill(0.5);
  const buckets = 64;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  reduceEnvelope(samples, buckets, min, max, rms);

  for (let i = 0; i < buckets; i++) {
    assert.ok(Number.isFinite(min[i]), `bucket ${i} min is not finite: ${min[i]}`);
    assert.ok(Number.isFinite(max[i]), `bucket ${i} max is not finite: ${max[i]}`);
    assert.ok(Number.isFinite(rms[i]), `bucket ${i} rms is not finite: ${rms[i]}`);
  }
});
