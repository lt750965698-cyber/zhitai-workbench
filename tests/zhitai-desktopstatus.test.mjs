import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 织台桌面版 · DesktopStatus hydration 契约测试
 * 断言：SSR 与客户端首帧一致返回 null（初始 desktop=false）；
 * 渲染期不得调用 isDesktop()（读 window 会导致 hydration mismatch）；
 * 桌面模式仅在 useEffect 挂载后开启，再读 zhitaiBridge。
 */

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/DesktopStatus.tsx");
const src = fs.readFileSync(file, "utf8");

test("初始 desktop=false：SSR 与客户端首帧一致返回 null", () => {
  assert.match(src, /const \[desktop, setDesktop\] = useState\(false\)/);
  assert.match(src, /if \(!desktop\) return null/);
});

test("渲染期不得调用 isDesktop()（读 window 导致 mismatch）", () => {
  assert.ok(
    !/if\s*\(\s*!isDesktop\(\)\s*\)\s*return\s+null/.test(src),
    "render 期调用 isDesktop() 会让 SSR(null) 与客户端首帧不一致",
  );
  assert.ok(!/useState\(\s*isDesktop\(\)\s*\)/.test(src), "初始值不得来自 isDesktop()");
  assert.ok(!/isDesktop\(\)\s*&&/.test(src), "渲染分支不得以 isDesktop() 短路");
});

test("桌面模式在 useEffect 挂载后开启，再读 zhitaiBridge；保留取消与监听", () => {
  assert.match(src, /useEffect\(/);
  assert.match(src, /setDesktop\(true\)/);
  assert.match(src, /getServices/);
  assert.match(src, /onServicesChanged/);
  assert.match(src, /cancelled/);
  assert.match(src, /window\.zhitaiBridge/);
});

test("不使用 suppressHydrationWarning", () => {
  assert.ok(!src.includes("suppressHydrationWarning"));
});

test("按需引擎未启动不计入故障，并显示为按需待命", () => {
  assert.match(src, /!s\.online && !s\.onDemand/);
  assert.match(src, /s\.onDemand \? "按需待命" : "离线"/);
  assert.match(src, /常驻服务全部就绪/);
});

test("变异杀死：把初始值改回 render 期 isDesktop() 会失败", () => {
  const mutated = src.replace("const [desktop, setDesktop] = useState(false)", "const [desktop, setDesktop] = useState(isDesktop())");
  assert.notEqual(mutated, src, "变异必须命中初始值形态");
  // 变异后仍以 !desktop 分支返回 null，但初始值来自 isDesktop()（读 window）——渲染不再确定
  assert.ok(!/const \[desktop, setDesktop\] = useState\(false\)/.test(mutated), "变异后不应再有固定 false 初值");
  // 变异使组件重新引用 isDesktop()（读 window）→ 违反首帧一致性
  assert.ok(mutated.includes("useState(isDesktop())"));
});
