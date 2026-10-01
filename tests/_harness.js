// tests/_harness.js — 极小的测试骨架（与 dsh-app 的 tests/*.js 同款约定）
//
// 支持异步用例**并且真的 await**。（dsh-app 的旧骨架忘了 await，一条 async 用例
// 里的断言失败会被静默吞掉、还打印 PASS —— 这里从一开始就修掉这个坑。）
'use strict';

const tests = [];
let passed = 0;
let failed = 0;
const failures = [];

function t(name, fn) { tests.push({ name, fn }); }

async function run() {
  for (const { name, fn } of tests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      passed++;
      console.log('PASS  ' + name);
    } catch (e) {
      failed++;
      failures.push({ name, error: e });
      console.log('FAIL  ' + name);
      console.log('      ' + (e && e.message ? e.message : String(e)));
    }
  }
  console.log('');
  console.log(`===== ${passed} passed, ${failed} failed =====`);
  if (failed > 0) {
    console.log('');
    for (const f of failures) {
      console.log('--- ' + f.name);
      console.log(f.error && f.error.stack ? f.error.stack : String(f.error));
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

module.exports = { t, run };
