// icon.js — 程序化生成应用/托盘 PNG 图标（零外部资源，纯 Node 实现）
//
// 图形：**圆角方块 + 竖向渐变 + 白色「汇流箭头」**
//   两条上游支流 45° 汇入，出口是一支实心箭头。语义就是本产品在做的事：
//   「多个上游 → 一个本地端点」。只用一个**连通**字形，缩到 16px 仍有清晰轮廓。
//
// 与旧版的区别（2026-10 重做，旧版是"圆形底 + 三条椭圆轨道 + 6 个环点 + 中心点"）：
//   ① 元素从 10 个减到 1 个 —— 旧版在 16px 下必然糊成一团，且"原子轨道"是 AI 产品最烂大街的套路
//   ② 加入 **4×4 超采样抗锯齿** —— 旧版是逐像素硬阈值，边缘锯齿在 16/24px 下非常明显
//   ③ 底色改为圆角方块 + 渐变，贴合 Windows 11 的图标语言；渐变由传入的状态色推导，
//      因此托盘图标的五种状态色自动获得同样的明暗层次
//
// 实现：SDF（有符号距离场）组合图形 → 手绘 RGBA 像素 → PNG 编码
//（zlib deflate + 表驱动 CRC32），与 Electron nativeImage 直接兼容。
'use strict';

const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// —— CRC32（PNG chunk 校验）——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// 由 RGBA 像素编码 PNG（rgba: Buffer/TypedArray，长度 w*h*4，行序自上而下）
function pngFromPixels(w, h, rgba) {
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  // 一次性建立整块像素的 view（避免按行重复拷贝的越界问题）
  const rgbaView = Buffer.from(rgba.buffer || rgba, rgba.byteOffset || 0, rgba.length || w * h * 4);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;   // filter: None
    rgbaView.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ *
 * 几何：全部用归一化坐标（0..1），与输出尺寸无关
 * ------------------------------------------------------------------ */

// 圆角方块
const PAD = 0.035;          // 方块四周留白（相对边长）
const TILE_R = 0.225;       // 圆角半径

// 字形：三条胶囊 + 一个三角。坐标经两轮视觉迭代定稿。
const STEM_R = 0.052;       // 笔画半径
const CAPS = [
  [0.215, 0.272, 0.478, 0.500, STEM_R],   // 上支流（45° 汇入）
  [0.215, 0.728, 0.478, 0.500, STEM_R],   // 下支流
  [0.460, 0.500, 0.645, 0.500, STEM_R],   // 主干（接箭头）
];
const ARROW = { tipX: 0.815, tipY: 0.500, w: 0.175, h: 0.168 };

/** 点到线段的距离（胶囊体的基础） */
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax; const vy = by - ay;
  const wx = px - ax; const wy = py - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? (wx * vx + wy * vy) / L2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 圆角方块的 SDF（<0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 字形命中判定：在任一胶囊内，或在箭头三角内 */
function insideGlyph(px, py) {
  for (let i = 0; i < CAPS.length; i++) {
    const c = CAPS[i];
    if (distSeg(px, py, c[0], c[1], c[2], c[3]) <= c[4]) return true;
  }
  // 箭头：顶点朝右的等腰三角（按到顶点的横向比例判定半高）
  const { tipX, tipY, w, h } = ARROW;
  if (px <= tipX && px >= tipX - w) {
    const t = (tipX - px) / w;
    if (Math.abs(py - tipY) <= h * t) return true;
  }
  return false;
}

/** 由状态色推导渐变的暗端（压暗但不脏：同时压一点饱和感） */
function darken(rgb, f) {
  return [
    Math.round(rgb[0] * (1 - f)),
    Math.round(rgb[1] * (1 - f)),
    Math.round(rgb[2] * (1 - f)),
  ];
}

const SS = 4;   // 每轴超采样倍数（4×4=16 个样本/像素）

/**
 * 渲染图标：圆角方块（竖向渐变）+ 白色汇流箭头。
 * @param size 输出边长（像素）
 * @param rgb  底色（托盘状态色；渐变的亮端即此色，暗端自动压暗）
 */
function renderIcon(size, rgb) {
  const w = size; const h = size;
  const rgba = new Uint8Array(w * h * 4);
  const top = rgb || COLORS.brand;
  const bot = darken(top, GRADIENT_DARKEN);
  const half = 0.5 - PAD;
  const samples = SS * SS;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rS = 0; let gS = 0; let bS = 0; let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (sdRoundRect(px, py, 0.5, 0.5, half, half, TILE_R) > 0) continue;
          hit++;
          if (insideGlyph(px, py)) { rS += 255; gS += 255; bS += 255; continue; }
          // 竖向渐变：从方块顶部到底部
          const t = (py - PAD) / (1 - 2 * PAD);
          const k = t < 0 ? 0 : (t > 1 ? 1 : t);
          rS += top[0] + (bot[0] - top[0]) * k;
          gS += top[1] + (bot[1] - top[1]) * k;
          bS += top[2] + (bot[2] - top[2]) * k;
        }
      }
      const i = (y * w + x) * 4;
      if (!hit) { rgba[i + 3] = 0; continue; }
      // 按键：命中样本数 / 总样本数 → 边缘半透明，天然抗锯齿
      rgba[i] = Math.round(rS / hit);
      rgba[i + 1] = Math.round(gS / hit);
      rgba[i + 2] = Math.round(bS / hit);
      rgba[i + 3] = Math.round(255 * hit / samples);
    }
  }
  return { buffer: Buffer.from(rgba.buffer), width: w, height: h };
}

// 生成 dataURL（Electron nativeImage.createFromDataURL 直接可用）
function iconDataURL(size, rgb) {
  const png = pngFromPixels(size, size, renderIcon(size, rgb).buffer);
  return 'data:image/png;base64,' + png.toString('base64');
}

// 生成 PNG Buffer（写文件用）
function iconPngBuffer(size, rgb) {
  return pngFromPixels(size, size, renderIcon(size, rgb).buffer);
}

// 生成 ICO（PNG-in-ICO，Vista+ 标准）：多尺寸条目 + 品牌色。
// 供 electron-builder 设置 exe 图标，保证托盘/窗口/exe 图案一致。
function iconIcoBuffer(rgb, sizes) {
  const list = sizes || [16, 32, 256];
  const pngs = list.map((s) => iconPngBuffer(s, rgb));
  const count = pngs.length;
  const headerLen = 6;
  const entryLen = 16;
  const dataOffset = headerLen + count * entryLen;
  const total = dataOffset + pngs.reduce((n, p) => n + p.length, 0);
  const buf = Buffer.alloc(total);
  buf.writeUInt16LE(0, 0);            // reserved
  buf.writeUInt16LE(1, 2);            // type: icon
  buf.writeUInt16LE(count, 4);
  let off = dataOffset;
  for (let i = 0; i < count; i++) {
    const s = list[i];
    const e = headerLen + i * entryLen;
    buf[e] = s >= 256 ? 0 : s;        // width（0=256）
    buf[e + 1] = s >= 256 ? 0 : s;    // height
    buf[e + 2] = 0;                   // palette
    buf[e + 3] = 0;                   // reserved
    buf.writeUInt16LE(1, e + 4);      // planes
    buf.writeUInt16LE(32, e + 6);     // bpp
    buf.writeUInt32LE(pngs[i].length, e + 8);
    buf.writeUInt32LE(off, e + 12);
    pngs[i].copy(buf, off);
    off += pngs[i].length;
  }
  return buf;
}

// 品牌蓝与其他状态色。
// brand 与界面 CSS 的 `--accent: #3b82f6` 完全一致 —— 图标与 UI 用同一个主色，
// 改配色时两边一起改，不会出现"图标是深蓝、按钮是亮蓝"这种不统一。
const COLORS = {
  brand: [59, 130, 246],      // = renderer/styles.css 的 --accent
  stopped: [138, 147, 163],   // 网关未运行
  starting: [245, 185, 60],   // 启动中
  ready: [62, 207, 142],      // 运行中
  failed: [232, 84, 77],      // 启动失败
  safe: [240, 155, 60],       // 需要留意
};

const GRADIENT_DARKEN = 0.38;

/**
 * 几何常量导出 —— **不是为了外部调用，是为了让"界面品牌标记与图标一致"可被机器校验**。
 *
 * `renderer/index.html` 里有一份等价的内联 SVG（同一套归一化坐标 ×100）。
 * 两处必须同步，否则界面左上角会和 exe / 托盘图标长得不一样。
 * 我写下那句"改图标时必须同时改这里"的注释之后，自己还是漏改过一次 ——
 * 所以 tests/unit.js 里有一条测试逐点比对这两份几何。
 */
const GEOMETRY = { PAD, TILE_R, STEM_R, CAPS, ARROW, GRADIENT_DARKEN };

module.exports = {
  pngFromPixels, renderIcon, iconDataURL, iconPngBuffer, iconIcoBuffer, COLORS, GEOMETRY,
};
