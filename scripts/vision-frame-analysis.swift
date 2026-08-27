#!/usr/bin/swift
import AppKit
import Foundation
import Vision

func cgImage(at path: String) -> CGImage? {
    guard let image = NSImage(contentsOfFile: path) else { return nil }
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }

var output: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
    guard let image = cgImage(at: path) else {
        output.append(["path": path, "status": "unavailable", "reason": "image_decode_failed"])
        continue
    }
    let faces = VNDetectFaceRectanglesRequest()
    let humans = VNDetectHumanRectanglesRequest()
    let horizon = VNDetectHorizonRequest()
    let classify = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    do {
        try handler.perform([faces, humans, horizon, classify])
        let faceRows = (faces.results ?? []).map { observation -> [String: Any] in
            let box = observation.boundingBox
            return ["x": round3(box.origin.x), "y": round3(box.origin.y), "width": round3(box.width), "height": round3(box.height), "area": round3(box.width * box.height)]
        }
        let humanRows = (humans.results ?? []).map { observation -> [String: Any] in
            let box = observation.boundingBox
            return ["x": round3(box.origin.x), "y": round3(box.origin.y), "width": round3(box.width), "height": round3(box.height), "area": round3(box.width * box.height)]
        }
        let largestFace = (faces.results ?? []).map { $0.boundingBox.width * $0.boundingBox.height }.max() ?? 0
        let largestHuman = (humans.results ?? []).map { $0.boundingBox.width * $0.boundingBox.height }.max() ?? 0
        let shotSize: String?
        if largestFace >= 0.20 { shotSize = "close_up" }
        else if largestFace >= 0.04 { shotSize = "medium_close_up" }
        else if largestHuman >= 0.35 { shotSize = "medium_full" }
        else if largestHuman > 0 { shotSize = "wide_or_full" }
        else { shotSize = nil }

        let angle = horizon.results?.first?.angle
        let cameraAngle: String?
        if let value = angle {
            let degrees = Double(value) * 180 / Double.pi
            cameraAngle = abs(degrees) >= 8 ? "dutch_tilt" : "level_horizon"
        } else { cameraAngle = nil }

        let labels = (classify.results ?? []).prefix(5).map { ["label": $0.identifier, "confidence": round3(Double($0.confidence))] as [String: Any] }
        output.append([
            "path": path,
            "status": "available",
            "width": image.width,
            "height": image.height,
            "faces": faceRows,
            "humans": humanRows,
            "shotSize": shotSize as Any,
            "cameraAngle": cameraAngle as Any,
            "horizonDegrees": angle.map { round3(Double($0) * 180 / Double.pi) } as Any,
            "sceneLabels": labels,
            "cameraMovement": NSNull(),
            "limitations": ["单帧无法可靠判断运镜", "无地平线时无法判断高低机位", "景别为人脸/人体占比规则推断"]
        ])
    } catch {
        output.append(["path": path, "status": "unavailable", "reason": String(describing: error)])
    }
}

let data = try JSONSerialization.data(withJSONObject: output, options: [])
FileHandle.standardOutput.write(data)
