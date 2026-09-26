// Transcode vertical reels to light web MP4 (H.264 + AAC) and grab a poster frame.
// Usage: transcode <src> <dst.mp4> <poster.jpg> <maxBytes>
import Foundation
import AVFoundation
import AppKit

setvbuf(stdout, nil, _IONBF, 0)

func even(_ v: CGFloat) -> Int { let i = Int(v.rounded()); return i - i % 2 }

func transcode(src: URL, dst: URL, maxBytes: Double, shortSide: CGFloat) throws {
    let asset = AVURLAsset(url: src)
    guard let vTrack = asset.tracks(withMediaType: .video).first else { throw NSError(domain: "no video", code: 1) }
    let aTrack = asset.tracks(withMediaType: .audio).first
    let duration = CMTimeGetSeconds(asset.duration)

    // bitrate so the whole file stays under maxBytes (5 % margin, 96 kbps audio)
    let audioBps = 96_000.0
    let videoBps = min(1_800_000.0, (maxBytes * 8.0 * 0.95) / duration - audioBps)

    let nat = vTrack.naturalSize
    let s = shortSide / min(nat.width, nat.height)
    let w = even(nat.width * s), h = even(nat.height * s)

    try? FileManager.default.removeItem(at: dst)
    let reader = try AVAssetReader(asset: asset)
    let writer = try AVAssetWriter(outputURL: dst, fileType: .mp4)
    writer.shouldOptimizeForNetworkUse = true

    let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ])
    vOut.alwaysCopiesSampleData = false
    reader.add(vOut)
    let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: w,
        AVVideoHeightKey: h,
        AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: Int(videoBps),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoMaxKeyFrameIntervalKey: 60,
            AVVideoAllowFrameReorderingKey: true
        ]
    ])
    vIn.transform = vTrack.preferredTransform
    vIn.expectsMediaDataInRealTime = false
    writer.add(vIn)

    var aOut: AVAssetReaderTrackOutput?
    var aIn: AVAssetWriterInput?
    if let aTrack = aTrack, let fd = aTrack.formatDescriptions.first,
       let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd as! CMAudioFormatDescription)?.pointee {
        let o = AVAssetReaderTrackOutput(track: aTrack, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
        reader.add(o); aOut = o
        let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: min(2, Int(asbd.mChannelsPerFrame)),
            AVSampleRateKey: asbd.mSampleRate,
            AVEncoderBitRateKey: Int(audioBps)
        ])
        i.expectsMediaDataInRealTime = false
        writer.add(i); aIn = i
    }

    guard reader.startReading() else { throw reader.error ?? NSError(domain: "reader", code: 2) }
    guard writer.startWriting() else { throw writer.error ?? NSError(domain: "writer", code: 3) }
    writer.startSession(atSourceTime: .zero)

    let group = DispatchGroup()
    func pump(_ input: AVAssetWriterInput, _ output: AVAssetReaderTrackOutput, _ label: String) {
        group.enter()
        var done = false
        input.requestMediaDataWhenReady(on: DispatchQueue(label: label)) {
            while input.isReadyForMoreMediaData && !done {
                if let sb = output.copyNextSampleBuffer() {
                    if !input.append(sb) { done = true; input.markAsFinished(); group.leave() }
                } else {
                    done = true; input.markAsFinished(); group.leave()
                }
            }
        }
    }
    pump(vIn, vOut, "video")
    if let aIn = aIn, let aOut = aOut { pump(aIn, aOut, "audio") }
    group.wait()

    let sem = DispatchSemaphore(value: 0)
    writer.finishWriting { sem.signal() }
    sem.wait()
    if writer.status != .completed { throw writer.error ?? NSError(domain: "finish", code: 4) }
    let size = (try? FileManager.default.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)?.doubleValue ?? 0
    print(String(format: "%@  %dx%d  %.1f s  video %.2f Mbps  -> %.1f MB", dst.lastPathComponent, w, h, duration, videoBps / 1e6, size / 1e6))
}

func poster(src: URL, dst: URL, at t: Double) throws {
    let gen = AVAssetImageGenerator(asset: AVURLAsset(url: src))
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: 960, height: 960)
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
    let cg = try gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil)
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else { throw NSError(domain: "jpeg", code: 5) }
    try data.write(to: dst)
    print("poster", dst.lastPathComponent, cg.width, "x", cg.height)
}

let args = CommandLine.arguments
guard args.count == 5, let maxBytes = Double(args[4]) else {
    print("usage: transcode <src> <dst.mp4> <poster.jpg> <maxBytes>"); exit(2)
}
do {
    try transcode(src: URL(fileURLWithPath: args[1]), dst: URL(fileURLWithPath: args[2]), maxBytes: maxBytes, shortSide: 540)
    try poster(src: URL(fileURLWithPath: args[2]), dst: URL(fileURLWithPath: args[3]), at: 1.5)
} catch {
    print("FAILED:", error); exit(1)
}
