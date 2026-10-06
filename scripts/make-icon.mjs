// make-icon.mjs — 用应用自己的图标生成器产出 .ico / .png（零外部素材）
//
// 图标是**程序化绘制**的（src/icon.js：圆角方块 + 竖向渐变 + 白色「汇流箭头」），
// 不依赖任何图片文件，因此换配色/换尺寸只要改一行。electron-builder 打 exe 图标需要 ≥256×256 的 .ico。
//
// 用法：node scripts/make-icon.mjs
'use strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const icon = require(path.join(ROOT, 'src', 'icon.js'));

const dir = path.join(ROOT, 'assets');
mkdirSync(dir, { recursive: true });

const ico = path.join(dir, 'llm-gateway.ico');
writeFileSync(ico, icon.iconIcoBuffer(icon.COLORS.brand, [16, 24, 32, 48, 64, 128, 256]));
console.log('[OK] ' + ico);

const png = path.join(dir, 'llm-gateway.png');
writeFileSync(png, icon.iconPngBuffer(256, icon.COLORS.brand));
console.log('[OK] ' + png);
