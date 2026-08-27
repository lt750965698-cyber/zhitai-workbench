#!/usr/bin/env python3
"""用 Qwen2.5-VL 对代表帧做结构化镜头语义分析。"""

from __future__ import annotations

import json
import re
import sys

from mlx_vlm import apply_chat_template, generate, load


MODEL_ID = "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"
SHOT_SIZE_MAP = {
    "极近景": "extreme_close_up", "特写": "close_up", "近景": "medium_close_up",
    "中近景": "medium_close_up", "中景": "medium", "中全景": "medium_full",
    "全景": "full", "广景": "wide", "大远景": "extreme_wide", "未知": "unknown",
}
CAMERA_ANGLE_MAP = {
    "平视": "eye_level", "眼平": "eye_level", "俯拍": "high_angle", "高角度": "high_angle",
    "仰拍": "low_angle", "低角度": "low_angle", "顶视": "top_down", "顶拍": "top_down",
    "荷兰角": "dutch_tilt", "未知": "unknown",
}


def parse_json(text: str):
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I | re.S)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        object_start = cleaned.find("{")
        object_end = cleaned.rfind("}")
        if object_start >= 0 and object_end > object_start:
            try:
                return json.loads(cleaned[object_start : object_end + 1])
            except json.JSONDecodeError:
                pass
        start = cleaned.find("[")
        end = cleaned.rfind("]")
        if start >= 0 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def needs_chinese_cleanup(payload) -> bool:
    body = json.dumps(payload, ensure_ascii=False)
    latin_words = len(re.findall(r"\b[A-Za-z]{3,}\b", body))
    han_chars = len(re.findall(r"[\u3400-\u9fff]", body))
    return latin_words > 12 and latin_words > han_chars / 3


def main() -> int:
    paths = sys.argv[1:9]
    if not paths:
        print(json.dumps({"status": "unavailable", "items": [], "note": "frame_required"}, ensure_ascii=False))
        return 0

    model, processor = load(MODEL_ID)
    instruction = (
        "你是短视频视觉取证与AI视频反推分析员。按输入图片顺序，只输出一个 JSON 对象，不要 Markdown。"
        "除枚举值和 JSON 键名外，所有字符串必须使用简体中文；英文输出视为格式错误。"
        "顶层必须有 originAssessment、reverseBlueprint、items 三项。"
        "originAssessment 必须含 type、confidence、evidence、uncertainties；type 仅允许 ai_generated/live_action/mixed/unknown。"
        "不能仅因画面精美就判断为AI；只列可见证据，不猜具体模型。无法确认就写 unknown。"
        "reverseBlueprint 必须含 subjectDesign、environment、visualStyle、materialsTextures、lightingColor、cameraGrammar、"
        "motionPhysics、pacingEditing、audioStrategy、consistencyAnchors、negativeConstraints、universalPrompt、retain、replace。"
        "视频运动、剪辑和音频无法从静帧确认时必须明确写‘需结合运镜/音频分析’，不得编造。"
        "universalPrompt 是可迁移的中文生成提示词：复用风格、空间关系、镜头语言和视觉节奏，但不要复制人物脸、品牌、文字或受保护角色。"
        "items 是数组；每项必须有 index、shotSize、cameraAngle、composition、lighting、subject、setting、evidence、confidence。"
        "shotSize 仅允许 extreme_close_up/close_up/medium_close_up/medium/medium_full/full/wide/extreme_wide/unknown；"
        "cameraAngle 仅允许 eye_level/high_angle/low_angle/top_down/dutch_tilt/unknown。"
        "composition、lighting、subject、setting、evidence 用简短中文；confidence 为 0 到 1。"
        "只写画面能观察到的事实；看不清就写 unknown，不推测镜头运动、品牌、人物身份或爆火原因。"
    )
    prompt = apply_chat_template(processor, model.config, instruction, num_images=len(paths))
    response = generate(model, processor, prompt, image=paths, max_tokens=1800, temperature=0.0, verbose=False).text
    payload = parse_json(response)
    if isinstance(payload, list):
        payload = {"originAssessment": {"type": "unknown", "confidence": 0, "evidence": [], "uncertainties": ["旧格式输出，未执行来源判断"]}, "reverseBlueprint": {}, "items": payload}
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise ValueError("model_output_not_object")
    if needs_chinese_cleanup(payload):
        cleanup_instruction = (
            "把下面 JSON 中所有自然语言值准确改写为简体中文，只输出 JSON，不要 Markdown。"
            "JSON 键名、index、confidence、type、shotSize、cameraAngle 的枚举值必须原样保留。"
            "不要增加画面中没观察到的信息，不猜品牌、模型、人物身份或爆火原因。\n"
            + json.dumps(payload, ensure_ascii=False)
        )
        try:
            cleanup_prompt = apply_chat_template(processor, model.config, cleanup_instruction, num_images=0)
            cleanup_response = generate(model, processor, cleanup_prompt, max_tokens=1900, temperature=0.0, verbose=False).text
            cleaned_payload = parse_json(cleanup_response)
            if isinstance(cleaned_payload, dict) and isinstance(cleaned_payload.get("items"), list):
                payload = cleaned_payload
        except Exception:
            pass
    items = payload["items"]
    normalized = []
    for offset, item in enumerate(items[: len(paths)]):
        if not isinstance(item, dict):
            continue
        normalized.append({
            "index": offset + 1,
            "path": paths[offset],
            "shotSize": SHOT_SIZE_MAP.get(item.get("shotSize"), item.get("shotSize") or "unknown"),
            "cameraAngle": CAMERA_ANGLE_MAP.get(item.get("cameraAngle"), item.get("cameraAngle") or "unknown"),
            "composition": item.get("composition") or "unknown",
            "lighting": item.get("lighting") or "unknown",
            "subject": item.get("subject") or "unknown",
            "setting": item.get("setting") or "unknown",
            "evidence": item.get("evidence") or "未提供证据",
            "confidence": max(0.0, min(1.0, float(item.get("confidence", 0.5)))),
        })
    print(json.dumps({
        "status": "available" if normalized else "unavailable",
        "provider": "Qwen2.5-VL-3B-Instruct 4-bit / MLX",
        "device": "Apple MLX",
        "originAssessment": payload.get("originAssessment") if isinstance(payload.get("originAssessment"), dict) else {"type": "unknown", "confidence": 0, "evidence": [], "uncertainties": ["模型未返回来源判断"]},
        "reverseBlueprint": payload.get("reverseBlueprint") if isinstance(payload.get("reverseBlueprint"), dict) else {},
        "items": normalized,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
