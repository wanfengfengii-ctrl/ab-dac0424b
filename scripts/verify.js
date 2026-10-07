'use strict';

// Compose 一次性服务 verify 使用：
//   1. 等待 API 健康；
//   2. 对全部源码做语法核查（构建可用性）；
//   3. 运行仓库自带测试；
//   4. 对运行中的 API 做端到端场景核对：
//      - 跨日期变更线点位分类（线两侧同域、反转不变、边界 BOUNDARY）；
//      - 各类非法围栏/非法点位拒绝（错误码与顶点/点位序号定位）；
//   5. 汇总并以退出码报告结果（0 全部通过，非 0 存在失败）。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const API_URL = process.env.API_URL || 'http://api:8080';
const CLASSIFY = `${API_URL}/api/geofences/classify`;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
}

async function waitHealthy(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API_URL}/health`);
      if (r.ok) return true;
      lastErr = `status ${r.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.error(`API 在 ${timeoutMs}ms 内未就绪：${lastErr}`);
  return false;
}

async function classify(body) {
  const r = await fetch(CLASSIFY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    // 非 JSON 响应
  }
  return { status: r.status, json };
}

function syntaxCheck() {
  const roots = ['src', 'test', 'scripts'];
  let bad = 0;
  for (const root of roots) {
    for (const file of fs.readdirSync(root)) {
      if (!file.endsWith('.js')) continue;
      const p = path.join(root, file);
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      if (r.status !== 0) {
        bad++;
        console.error(`    语法错误 ${p}: ${r.stderr}`);
      }
    }
  }
  return bad === 0;
}

function runUnitTests() {
  const r = spawnSync(process.execPath, ['test/run-tests.js'], { stdio: 'inherit' });
  return r.status === 0;
}

async function e2eScenarios() {
  console.log('\n[4] 端到端：跨日期变更线分类');
  const P = (lat, lon) => ({ lat: String(lat), lon: String(lon) });
  // 170°E ↔ 170°W 之间跨日期变更线的管制带（纬度 ±10）
  const strip = [P(10, 170), P(10, -170), P(-10, -170), P(-10, 170)];
  const points = [
    P(0, 179.999), P(0, -179.999), // 变更线两侧同属一区
    P(9, 175), P(-9, -175),
    P(0, 0), P(20, 175),           // 远离变更线 / 纬度在外
    P(10, 170), P(10, -170), P(-10, -170), P(-10, 170), // 顶点
    P(0, 170), P(10, 175), P(10, -175),                // 边
  ];
  const expected = [
    'INSIDE', 'INSIDE', 'INSIDE', 'INSIDE',
    'OUTSIDE', 'OUTSIDE',
    'BOUNDARY', 'BOUNDARY', 'BOUNDARY', 'BOUNDARY',
    'BOUNDARY', 'BOUNDARY', 'BOUNDARY',
  ];
  let res = await classify({ polygon: strip, points });
  check('跨线围栏线两侧均 INSIDE / 外部 OUTSIDE / 顶点与边 BOUNDARY',
    res.status === 200 && JSON.stringify(res.json.results) === JSON.stringify(expected),
    `got ${res.status} ${JSON.stringify(res.json)}`);
  check('结果按点位原顺序返回',
    res.status === 200 && res.json.results.length === points.length);

  const resRev = await classify({ polygon: [...strip].reverse(), points });
  check('顶点顺序反转不改变裁决',
    resRev.status === 200 && JSON.stringify(resRev.json.results) === JSON.stringify(expected),
    `got ${JSON.stringify(resRev.json)}`);

  // 紧贴变更线两侧的对称点必须结论一致（核心诉求：跨系统结论不相反）
  const sym = await classify({
    polygon: strip,
    points: [P(1.5, 179.999999), P(1.5, -179.999999), P(-1.5, 179.999999), P(-1.5, -179.999999)],
  });
  check('变更线两侧对称点结论一致',
    sym.status === 200 && sym.json.results.every((v) => v === 'INSIDE'),
    `got ${JSON.stringify(sym.json)}`);

  console.log('\n[5] 端到端：非法围栏与非法点位拒绝');
  const cases = [
    ['零面积（共线）', { polygon: [P(0, 0), P(0, 10), P(0, 20)], points: [P(0, 5)] }, 'ZERO_AREA_POLYGON', null],
    ['自交多边形', { polygon: [P(0, 0), P(0, 10), P(10, 10), P(-5, 5), P(10, 0)], points: [P(1, 1)] }, 'SELF_INTERSECTING_POLYGON', null],
    ['经度恰差 180°', { polygon: [P(0, -90), P(0, 90), P(10, 90), P(10, -90)], points: [P(1, 0)] }, 'ANTIMERIDIAN_AMBIGUOUS_EDGE', 'polygon[0]'],
    ['重复相邻顶点', { polygon: [P(0, 0), P(0, 0), P(10, 10), P(10, 0)], points: [P(1, 1)] }, 'DUPLICATE_VERTEX', 'polygon[1]'],
    ['顶点数不足', { polygon: [P(0, 0), P(1, 1)], points: [P(0, 0)] }, 'INVALID_POLYGON', null],
    ['顶点数超过 128', { polygon: Array.from({ length: 129 }, (_, i) => P(1, i % 2 ? 1 : 0.1 + (i % 50) * 0.5)), points: [P(0, 0)] }, 'INVALID_POLYGON', null],
    ['纬度越界（=90）', { polygon: strip, points: [P(5, 5), P(90, 5)] }, 'LAT_OUT_OF_RANGE', 'points[1]'],
    ['经度越界（=180）', { polygon: strip, points: [P(5, 180)] }, 'LON_OUT_OF_RANGE', 'points[0].lon'],
    ['非有限十进制', { polygon: strip, points: [P(5, 5), { lat: 'NaN', lon: 5 }] }, 'INVALID_COORDINATE', 'points[1]'],
    ['点位数量超过 500', { polygon: strip, points: Array(501).fill(P(0, 0)) }, 'INVALID_POINTS', null],
  ];
  for (const [name, body, code, where] of cases) {
    const r = await classify(body);
    const ok = r.status === 400 && r.json && r.json.error && r.json.error.code === code &&
      (where === null || (r.json.error.where || '').includes(where));
    check(`拒绝：${name}（${code}${where ? ` @ ${where}` : ''}）`, ok,
      `got ${r.status} ${JSON.stringify(r.json)}`);
  }

  console.log('\n[6] 端到端：其他协议约束');
  const health = await fetch(`${API_URL}/health`);
  check('GET /health 返回 200', health.status === 200);

  const oversize = await fetch(CLASSIFY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      polygon: strip,
      points: Array(400).fill(P(1.23456789, 2.3456789)),
      padding: 'x'.repeat(1024 * 1024 + 2048),
    }),
  });
  const overJson = await oversize.json().catch(() => null);
  check('正文超过 1 MiB 返回 413',
    oversize.status === 413 && overJson && overJson.error.code === 'BODY_TOO_LARGE',
    `got ${oversize.status}`);

  const badJson = await fetch(CLASSIFY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  check('非法 JSON 返回 400', badJson.status === 400);
}

(async () => {
  console.log(`[1] 等待 API 就绪（${API_URL}）...`);
  if (!(await waitHealthy())) process.exit(1);
  console.log('    API 已健康');

  console.log('\n[2] 源码语法/构建核查');
  check('全部 JS 文件通过 node --check', syntaxCheck());

  console.log('\n[3] 仓库单元与 HTTP 测试');
  check('node test/run-tests.js 全部通过', runUnitTests());

  await e2eScenarios();

  console.log(`\n==== verify 结果：${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`} ====`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('verify 执行异常：', err);
  process.exit(2);
});
