#!/usr/bin/env python3
"""用全局光流/仿射变换估计每个真实镜头的相机运动。"""

from __future__ import annotations

import json
import math
import sys

import cv2
import numpy as np


def analyze_scene(capture, start, end, width, height):
    duration = max(0.0, end - start)
    sample_count = max(3, min(12, int(duration * 3) + 1))
    times = np.linspace(start, max(start, end - 0.03), sample_count)
    frames = []
    for second in times:
        capture.set(cv2.CAP_PROP_POS_MSEC, float(second) * 1000)
        ok, frame = capture.read()
        if ok:
            frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))

    measures = []
    for previous, current in zip(frames, frames[1:]):
        points = cv2.goodFeaturesToTrack(previous, maxCorners=250, qualityLevel=0.01, minDistance=8, blockSize=7)
        if points is None or len(points) < 12:
            continue
        tracked, status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None)
        if tracked is None or status is None:
            continue
        src = points[status.reshape(-1) == 1].reshape(-1, 2)
        dst = tracked[status.reshape(-1) == 1].reshape(-1, 2)
        if len(src) < 12:
            continue
        matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.5)
        if matrix is None:
            continue
        a, b, dx = matrix[0]
        _, _, dy = matrix[1]
        scale = math.sqrt(float(a * a + b * b)) - 1.0
        rotation = math.degrees(math.atan2(float(b), float(a)))
        inlier_ratio = float(np.mean(inliers)) if inliers is not None else 0.0
        measures.append((float(dx) / width, float(dy) / height, scale, rotation, inlier_ratio))

    if not measures:
        return {"movement": "unknown", "confidence": 0.0, "evidence": "有效光流特征不足"}
    values = np.asarray(measures, dtype=np.float64)
    dx, dy, scale, rotation, inliers = [float(np.median(values[:, index])) for index in range(5)]
    translation = math.hypot(dx, dy)
    if inliers < 0.25:
        movement = "unknown"
    elif translation < 0.0025 and abs(scale) < 0.0025 and abs(rotation) < 0.25:
        movement = "static"
    elif abs(scale) > 0.004 and abs(scale) > translation * 0.75:
        movement = "zoom_in" if scale > 0 else "zoom_out"
    elif abs(dx) > abs(dy) * 1.35 and abs(dx) > 0.003:
        movement = "horizontal_pan"
    elif abs(dy) > abs(dx) * 1.35 and abs(dy) > 0.003:
        movement = "vertical_tilt"
    elif abs(rotation) > 0.7:
        movement = "roll_or_handheld"
    else:
        movement = "moving_or_handheld"
    confidence = max(0.2, min(0.95, inliers * min(1.0, len(measures) / 4)))
    return {
        "movement": movement,
        "confidence": round(confidence, 3),
        "evidence": f"全局光流：dx={dx:.4f}W, dy={dy:.4f}H, scale={scale:+.4f}, rotation={rotation:+.2f}°, inliers={inliers:.2f}",
    }


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"status": "unavailable", "scenes": [], "note": "video_and_scenes_required"}, ensure_ascii=False))
        return 0
    scenes = json.loads(sys.argv[2])
    capture = cv2.VideoCapture(sys.argv[1])
    if not capture.isOpened():
        print(json.dumps({"status": "unavailable", "scenes": [], "note": "video_open_failed"}, ensure_ascii=False))
        return 0
    width = max(1.0, float(capture.get(cv2.CAP_PROP_FRAME_WIDTH)))
    height = max(1.0, float(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    results = []
    for index, scene in enumerate(scenes):
        start = float(scene.get("startSeconds", 0))
        end = float(scene.get("endSeconds", start))
        results.append({"index": index + 1, "startSeconds": start, "endSeconds": end, **analyze_scene(capture, start, end, width, height)})
    capture.release()
    print(json.dumps({"status": "available" if results else "unavailable", "provider": "OpenCV global optical flow", "scenes": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
