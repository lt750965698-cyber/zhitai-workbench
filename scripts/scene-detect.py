#!/usr/bin/env python3
"""织台对 PySceneDetect 的极薄 JSON 适配层。

只负责运行上游 AdaptiveDetector 并输出切镜边界；不复制检测算法。
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 2 or not os.path.isfile(sys.argv[1]):
        print(json.dumps({"status": "unavailable", "error": "video_not_found"}, ensure_ascii=False))
        return 0

    try:
        import scenedetect
        from scenedetect import AdaptiveDetector, detect

        detected = detect(
            sys.argv[1],
            AdaptiveDetector(adaptive_threshold=3.0, min_scene_len=8),
            show_progress=False,
            start_in_scene=True,
        )
        scenes = []
        for index, (start, end) in enumerate(detected):
            scenes.append({
                "index": index + 1,
                "startSeconds": round(start.get_seconds(), 3),
                "endSeconds": round(end.get_seconds(), 3),
                "startFrame": start.frame_num,
                "endFrame": max(start.frame_num, end.frame_num - 1),
                "startTimecode": start.get_timecode(),
                "endTimecode": end.get_timecode(),
            })
        print(json.dumps({
            "status": "available" if scenes else "unavailable",
            "provider": "PySceneDetect",
            "version": scenedetect.__version__,
            "detector": "AdaptiveDetector",
            "sceneCount": len(scenes),
            "scenes": scenes,
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({
            "status": "unavailable",
            "provider": "PySceneDetect",
            "error": type(error).__name__,
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
