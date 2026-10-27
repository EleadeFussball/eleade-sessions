import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, canEncodeVideo } from 'mediabunny';

/**
 * Shrinks a training clip on the coach's phone before it is uploaded, using the phone's own video encoder
 * (WebCodecs). The aim is a much smaller file that looks the same at phone and social media size:
 *  - H.264 in an MP4 (plays everywhere), same frame rate, sound kept as it is where possible
 *  - 4K is scaled down to 1080p, which is plenty for analysis; 1080p and below keeps its size
 *  - the bitrate is set generously for football footage (about 8 Mbps at 1080p30)
 * Anything that could cost quality or does not need it is uploaded untouched: small files, clips that are already
 * at a low bitrate, HDR clips (colours would change), and phones that cannot encode. Any error also falls back
 * to the original, so a clip never fails to upload because of compression.
 */
export type CompressResult = { file: File; compressed: boolean; note: string };

const MIN_BYTES = 12 * 1024 * 1024;   // smaller than this is not worth it
const BASE_BITRATE = 8_000_000;       // 1080p at 30 fps
const BASE_PIXELS = 1920 * 1080;
const MAX_LONG = 1920;
const MAX_SHORT = 1080;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** What the clip would be compressed to, or why it is left alone. Pure, so it can be tested. */
export function planCompression(info: { bytes: number; width: number; height: number; bitrate: number; fps: number; hdr: boolean }):
  { skip: string } | { width: number; height: number; bitrate: number } {
  if (info.bytes < MIN_BYTES) return { skip: 'already small' };
  if (info.hdr) return { skip: 'HDR clip, kept as recorded so the colours stay right' };
  const scale = Math.min(1, MAX_LONG / Math.max(info.width, info.height), MAX_SHORT / Math.min(info.width, info.height));
  const width = even(info.width * scale), height = even(info.height * scale);
  const fpsFactor = info.fps > 40 ? 1.5 : 1;
  const bitrate = Math.round(Math.min(16_000_000, Math.max(3_000_000, BASE_BITRATE * (width * height) / BASE_PIXELS * fpsFactor)));
  // same size and already close to the target: re-encoding would only lose quality
  if (scale === 1 && info.bitrate > 0 && info.bitrate < bitrate * 1.3) return { skip: 'already at a low bitrate' };
  return { width, height, bitrate };
}

export async function compressClip(file: File, onProgress: (pct: number) => void, opts: { codec?: 'avc' | 'vp9' } = {}): Promise<CompressResult> {
  const keep = (note: string): CompressResult => ({ file, compressed: false, note });
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return keep('this phone cannot compress video in the app');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return keep('no video found');
    const stats = await track.computePacketStats(120);
    const plan = planCompression({
      bytes: file.size, width: track.displayWidth, height: track.displayHeight,
      bitrate: stats.averageBitrate, fps: stats.averagePacketRate, hdr: await track.hasHighDynamicRange(),
    });
    if ('skip' in plan) return keep(plan.skip);

    const codec = opts.codec ?? 'avc';
    if (!(await canEncodeVideo(codec, { width: plan.width, height: plan.height, bitrate: plan.bitrate }))) return keep('this phone cannot encode H.264 in the browser');

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input, output,
      video: { codec, width: plan.width, height: plan.height, fit: 'contain', quality: new Quality({ bitrate: plan.bitrate }) },
    });
    if (!conversion.isValid) return keep('the clip could not be read for compression');
    conversion.onProgress = (p) => onProgress(Math.max(0, Math.min(100, Math.round(p * 100))));
    await conversion.execute();

    const buf = (output.target as BufferTarget).buffer;
    if (!buf || buf.byteLength === 0) return keep('compression produced nothing');
    // only worth it if it is clearly smaller
    if (buf.byteLength > file.size * 0.85) return keep('compressing would not save enough');
    const name = file.name.replace(/\.[a-z0-9]{2,5}$/i, '') + '.mp4';
    return { file: new File([buf], name, { type: 'video/mp4' }), compressed: true, note: '' };
  } catch (e) {
    return keep(`compression failed (${e instanceof Error ? e.message : 'unknown'})`);
  } finally {
    input.dispose();
  }
}
