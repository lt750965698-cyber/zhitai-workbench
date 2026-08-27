# Synthetic MP4 fixtures

These files are generated entirely from FFmpeg's `testsrc2` source. They do not
contain recorded material, user data, source-file metadata, or network content.
The mono AAC track is a generated 440 Hz sine wave.

Generation commands (FFmpeg 8.0.1):

```sh
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=64x64:rate=5:duration=1' \
  -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=1' \
  -map_metadata -1 -shortest -c:v mpeg4 -q:v 8 -pix_fmt yuv420p -threads 1 \
  -c:a aac -b:a 24k -ar 16000 -ac 1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -movflags +faststart \
  sample-faststart.mp4

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=64x64:rate=5:duration=1' \
  -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=1' \
  -map_metadata -1 -shortest -c:v mpeg4 -q:v 8 -pix_fmt yuv420p -threads 1 \
  -c:a aac -b:a 24k -ar 16000 -ac 1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  sample-moov-at-end.mp4

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x240:rate=10:duration=3' \
  -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=3' \
  -map_metadata -1 -shortest -c:v mpeg4 -q:v 7 -pix_fmt yuv420p -threads 1 \
  -c:a aac -b:a 24k -ar 16000 -ac 1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -movflags +faststart \
  sample-watchable.mp4
```

Expected SHA-256 checksums:

```text
81cf6f50e7647eec4a60455fcb1ef429174af69648ad251042d5e801cc62e76b  sample-faststart.mp4
440c58083f6b2ba376ad0a97f9d99657cd91b57ebb2c2d38157f49ccb30875e6  sample-moov-at-end.mp4
ebc8f323f2353cf38a8a53ff3a3eb3c775024825a663ef205c1be60fd999abda  sample-watchable.mp4
```
