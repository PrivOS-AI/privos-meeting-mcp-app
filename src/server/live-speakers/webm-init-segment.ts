/**
 * MediaRecorder emits the WebM/EBML header + codec init segment ONLY in the
 * very first blob (`seq 0`); every later timeslice blob (`seq >= 1`) is a bare
 * Opus Cluster with no header, so ffmpeg cannot decode it standalone (this is
 * exactly why the live chunk worker used to fail on parts >= 1 with "Invalid
 * data found when processing input"). The post-meeting job never hit this
 * because it concatenates part 0 first.
 *
 * Fix: cache the init segment (all bytes before the first Cluster) from part 0
 * once, then prepend it to each later part before decoding. Verified
 * empirically that `init + clusterN` decodes to exactly that part's audio with
 * NO leading-silence padding, even though the cluster's own timecode is the
 * absolute offset from recording start (ffmpeg's wav muxer writes samples from
 * the first packet without padding for a positive start time).
 */

/** EBML element id for a WebM Cluster (`0x1F43B675`). */
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

/**
 * Returns the bytes of `part0Bytes` that precede the first Cluster — the EBML
 * header, Segment start, Info, Tracks (with the Opus codec-private data), etc.
 * When no Cluster marker is present (unexpected — a part with only header or a
 * malformed blob) the whole buffer is returned unchanged, so a caller that
 * prepends it to a real cluster still gets a decodable stream.
 */
export function extractWebmInitSegment(part0Bytes: Buffer): Buffer {
  const firstCluster = part0Bytes.indexOf(CLUSTER_ID);
  if (firstCluster <= 0) return part0Bytes;
  return part0Bytes.subarray(0, firstCluster);
}
