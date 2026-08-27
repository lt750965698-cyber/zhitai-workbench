#!/usr/bin/env python3
"""从 Demucs 的人声/伴奏 stem 提取可复核的声音特征。"""

from __future__ import annotations

import json
import math
import sys

import librosa
import numpy as np


def finite(value):
    value = float(np.asarray(value).reshape(-1)[0])
    return value if math.isfinite(value) else None


def load_mono(path):
    audio, sample_rate = librosa.load(path, sr=22050, mono=True)
    return audio.astype(np.float32), sample_rate


def common_features(audio, sample_rate):
    if audio.size == 0:
        return {"durationSeconds": 0, "rmsMean": None, "rmsPeak": None, "silenceRatio": None}
    rms = librosa.feature.rms(y=audio, frame_length=2048, hop_length=512)[0]
    peak = float(np.max(rms)) if rms.size else 0.0
    threshold = max(peak * 0.12, 1e-4)
    silence_ratio = float(np.mean(rms < threshold)) if rms.size else None
    return {
        "durationSeconds": round(float(audio.size / sample_rate), 3),
        "rmsMean": round(float(np.mean(rms)), 6) if rms.size else None,
        "rmsPeak": round(peak, 6),
        "silenceRatio": round(silence_ratio, 4) if silence_ratio is not None else None,
    }


def voice_features(audio, sample_rate):
    result = common_features(audio, sample_rate)
    try:
        f0, _, _ = librosa.pyin(audio, fmin=65, fmax=500, sr=sample_rate, frame_length=2048, hop_length=512)
        voiced = f0[np.isfinite(f0)]
    except Exception:
        voiced = np.array([], dtype=np.float32)
    median_pitch = float(np.median(voiced)) if voiced.size else None
    low_pitch = float(np.percentile(voiced, 10)) if voiced.size else None
    high_pitch = float(np.percentile(voiced, 90)) if voiced.size else None
    if median_pitch is None:
        pitch_label = "音高未取得"
    elif median_pitch < 135:
        pitch_label = "偏低沉"
    elif median_pitch > 230:
        pitch_label = "偏明亮"
    else:
        pitch_label = "中等音高"
    silence_ratio = result.get("silenceRatio")
    pause_label = "停顿未知" if silence_ratio is None else "停顿较多" if silence_ratio > 0.45 else "停顿适中" if silence_ratio > 0.22 else "语流连续"
    result.update({
        "pitchMedianHz": round(median_pitch, 2) if median_pitch is not None else None,
        "pitchP10Hz": round(low_pitch, 2) if low_pitch is not None else None,
        "pitchP90Hz": round(high_pitch, 2) if high_pitch is not None else None,
        "pitchLabel": pitch_label,
        "pauseLabel": pause_label,
        "styleObserved": f"{pitch_label}、{pause_label}",
    })
    return result


def background_features(audio, sample_rate):
    result = common_features(audio, sample_rate)
    try:
        tempo, _ = librosa.beat.beat_track(y=audio, sr=sample_rate)
        tempo = finite(tempo)
    except Exception:
        tempo = None
    try:
        centroid = librosa.feature.spectral_centroid(y=audio, sr=sample_rate)
        centroid_mean = float(np.mean(centroid)) if centroid.size else None
    except Exception:
        centroid_mean = None
    rms_mean = result.get("rmsMean") or 0
    result.update({
        "tempoBpm": round(tempo, 1) if tempo is not None and tempo > 0 else None,
        "spectralCentroidHz": round(centroid_mean, 1) if centroid_mean is not None else None,
        "presence": "未检测到明显伴奏" if rms_mean < 0.002 else "检测到伴奏/环境声",
    })
    return result


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"status": "error", "error": "vocals_and_background_required"}, ensure_ascii=False))
        return 2
    vocals, sr = load_mono(sys.argv[1])
    background, bg_sr = load_mono(sys.argv[2])
    print(json.dumps({
        "status": "available",
        "provider": "Demucs 4.0.1 + librosa 0.10.2",
        "voice": voice_features(vocals, sr),
        "background": background_features(background, bg_sr),
        "bgmIdentification": {
            "status": "unavailable",
            "title": None,
            "provider": "Chromaprint/AcoustID",
            "note": "本机尚未配置 AcoustID 客户端密钥；只保留可观察的节奏与声学特征",
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
