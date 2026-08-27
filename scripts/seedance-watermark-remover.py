#!/usr/bin/env python3
"""织台 Seedance/豆包动态角标清理器。

算法参考 SamurAIGPT/seedance-2.0-watermark-remover（MIT）的 OpenCV TELEA
+ ffmpeg 回封装路线。豆包当前导出的视频会让“豆包”角标在左上和右下之间
跳动，所以这里先逐帧判断角标所在角落，做时间平滑后只修复该帧对应的小区域。
检测不可靠时宁可停止，避免无水印区域被整段误伤。
"""

import argparse
import os
import shutil
import subprocess
import tempfile

import cv2
import numpy as np


# 豆包当前 9:16 导出的两处角标区域。区域按画面比例描述，既兼容 720p，
# 也兼容 1080p；只覆盖角标本身及少量压缩光晕。
REGIONS = {
    "top_left": (0.052, 0.018, 0.155, 0.066),
    "bottom_right": (0.855, 0.927, 0.982, 0.992),
}


def region_pixels(name, width, height):
    x0, y0, x1, y1 = REGIONS[name]
    return (
        max(0, int(width * x0)),
        max(0, int(height * y0)),
        min(width, int(width * x1)),
        min(height, int(height * y1)),
    )


def watermark_score(frame, name):
    height, width = frame.shape[:2]
    x0, y0, x1, y1 = region_pixels(name, width, height)
    roi = frame[y0:y1, x0:x1]
    if roi.size == 0:
        return 0.0
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    edges = cv2.Canny(gray, 55, 145)
    # 角标由低饱和的浅色笔画组成；边缘密度负责识别字形，浅色比例帮助压低
    # 地板纹理等自然边缘的分数。
    edge_density = float(np.count_nonzero(edges)) / float(edges.size)
    pale_density = float(np.count_nonzero((gray >= 145) & (hsv[:, :, 1] <= 100))) / float(gray.size)
    return edge_density + min(pale_density, 0.20) * 0.12


def detect_positions(input_path, total, fps):
    capture = cv2.VideoCapture(input_path)
    top_scores = []
    bottom_scores = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        top_scores.append(watermark_score(frame, "top_left"))
        bottom_scores.append(watermark_score(frame, "bottom_right"))
    capture.release()
    if len(top_scores) < max(1, total // 2):
        raise RuntimeError("无法完整读取豆包视频，动态水印识别已停止")

    top_scores = np.asarray(top_scores, dtype=np.float32)
    bottom_scores = np.asarray(bottom_scores, dtype=np.float32)
    # 水印通常每隔数秒跳一次。约 0.5 秒的中值窗口可以滤掉灯光、家具边缘
    # 等短暂干扰，又不会把一次跳转拖得太久。
    radius = max(3, min(12, int(round(fps * 0.25))))
    smooth_top = np.empty_like(top_scores)
    smooth_bottom = np.empty_like(bottom_scores)
    for index in range(len(top_scores)):
        start = max(0, index - radius)
        end = min(len(top_scores), index + radius + 1)
        smooth_top[index] = float(np.median(top_scores[start:end]))
        smooth_bottom[index] = float(np.median(bottom_scores[start:end]))

    positions = []
    for top, bottom in zip(smooth_top, smooth_bottom):
        strongest = max(float(top), float(bottom))
        if strongest < 0.012:
            positions.append(None)
        elif top > bottom * 1.08:
            positions.append("top_left")
        elif bottom > top * 1.08:
            positions.append("bottom_right")
        else:
            # 分数接近时交给相邻帧决定，避免在同一秒里左右抖动。
            positions.append(None)

    # 补齐短暂淡入淡出或分数接近的帧。仅在 0.75 秒范围内借用最近位置；
    # 更长的空白说明算法与素材不匹配，应保留原画面。
    reach = max(4, int(round(fps * 0.75)))
    known = [index for index, value in enumerate(positions) if value]
    if not known or len(known) < len(positions) * 0.35:
        raise RuntimeError("未能可靠识别豆包动态水印位置；为避免误伤画面已停止")
    for index, value in enumerate(positions):
        if value:
            continue
        nearest = min(known, key=lambda candidate: abs(candidate - index))
        if abs(nearest - index) <= reach:
            positions[index] = positions[nearest]

    # 清除少于 0.2 秒的孤立反转段。
    minimum_run = max(3, int(round(fps * 0.20)))
    index = 0
    while index < len(positions):
        end = index + 1
        while end < len(positions) and positions[end] == positions[index]:
            end += 1
        if positions[index] and end - index < minimum_run:
            before = positions[index - 1] if index > 0 else None
            after = positions[end] if end < len(positions) else None
            if before and before == after:
                positions[index:end] = [before] * (end - index)
        index = end
    return positions


def build_mask(name, width, height):
    mask = np.zeros((height, width), dtype=np.uint8)
    x0, y0, x1, y1 = region_pixels(name, width, height)
    # 圆角矩形让 TELEA 的边界过渡更自然，减少修复区出现硬直边。
    radius = max(3, int(round(min(width, height) * 0.006)))
    cv2.rectangle(mask, (x0 + radius, y0), (x1 - radius, y1), 255, -1)
    cv2.rectangle(mask, (x0, y0 + radius), (x1, y1 - radius), 255, -1)
    cv2.circle(mask, (x0 + radius, y0 + radius), radius, 255, -1)
    cv2.circle(mask, (x1 - radius, y0 + radius), radius, 255, -1)
    cv2.circle(mask, (x0 + radius, y1 - radius), radius, 255, -1)
    cv2.circle(mask, (x1 - radius, y1 - radius), radius, 255, -1)
    return mask


def remove_watermark(input_path, output_path):
    capture = cv2.VideoCapture(input_path)
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    if total <= 0 or fps <= 0 or width <= 0 or height <= 0:
        raise RuntimeError("无法读取豆包视频参数")

    positions = detect_positions(input_path, total, fps)
    masks = {name: build_mask(name, width, height) for name in REGIONS}

    frame_dir = tempfile.mkdtemp(prefix="zhitai-seedance-clean-")
    capture = cv2.VideoCapture(input_path)
    try:
        written = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            position = positions[written] if written < len(positions) else None
            result = (
                cv2.inpaint(frame, masks[position], inpaintRadius=7, flags=cv2.INPAINT_TELEA)
                if position else frame
            )
            if not cv2.imwrite(os.path.join(frame_dir, f"{written:06d}.png"), result):
                raise RuntimeError("去水印中间帧写入失败")
            written += 1
        capture.release()
        if written < max(1, total // 2):
            raise RuntimeError("去水印只处理到部分画面")
        ffmpeg = os.environ.get("ZHITAI_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", str(fps), "-i", os.path.join(frame_dir, "%06d.png"),
            "-i", input_path, "-map", "0:v:0", "-map", "1:a?", "-map_metadata", "1",
            "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
            "-c:a", "copy", "-movflags", "+faststart", output_path,
        ]
        completed = subprocess.run(command, capture_output=True, text=True)
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or "ffmpeg 回封装失败")[-500:])
    finally:
        capture.release()
        shutil.rmtree(frame_dir, ignore_errors=True)
    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 1024:
        raise RuntimeError("去水印输出文件无效")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("-o", "--output", required=True)
    args = parser.parse_args()
    remove_watermark(args.input, args.output)


if __name__ == "__main__":
    main()
