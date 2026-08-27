#!/usr/bin/env python3
"""WhisperX 环境内的轻量逐词时间码适配器。

使用 WhisperX 同一套 faster-whisper 转写核心生成逐词时间码，不依赖额外的
中文 wav2vec2 强制对齐模型。模型缓存补全后可再升级为 WhisperX align。
"""

from __future__ import annotations

import json
import os
import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"status": "error", "error": "video_path_required"}, ensure_ascii=False))
        return 2

    model_name = os.environ.get("WHISPERX_MODEL", "base")
    language = os.environ.get("WHISPERX_LANGUAGE", "zh")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    iterator, info = model.transcribe(
        sys.argv[1],
        language=language,
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )

    segments = []
    words = []
    for index, segment in enumerate(iterator, start=1):
        segment_words = []
        for word in segment.words or []:
            item = {
                "word": str(word.word or "").strip(),
                "start": float(word.start) if word.start is not None else None,
                "end": float(word.end) if word.end is not None else None,
                "score": float(word.probability) if word.probability is not None else None,
                "speaker": None,
            }
            if item["word"]:
                segment_words.append(item)
                words.append(item)
        segments.append({
            "index": index,
            "start": float(segment.start),
            "end": float(segment.end),
            "text": str(segment.text or "").strip(),
            "speaker": None,
            "words": segment_words,
        })

    print(json.dumps({
        "status": "available" if segments else "unavailable",
        "provider": "WhisperX 3.7.5 / faster-whisper word timestamps",
        "language": getattr(info, "language", language),
        "alignment": "word" if any(word.get("start") is not None for word in words) else "segment",
        "diarization": "unavailable",
        "note": "逐词时间码可用；说话人区分需配置 Hugging Face 授权后启用",
        "segments": segments,
        "words": words,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
